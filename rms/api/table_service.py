"""Dining-floor actions. Store ownership and POS capabilities are checked server-side."""

import math
from copy import deepcopy
import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, now_datetime, add_to_date

from rms.api import pos
from rms.table_service import ACTIVE_ORDER_STATUSES, lock_tables, assert_table_available, current_reservations, conflicting_reservations, visit_overlaps


@frappe.whitelist()
def get_floor(store):
	tables = pos.get_tables(store)
	reservations = current_reservations(store)
	order_names = [o["order"] for t in tables for o in t.open_orders]
	meta = (
		{
			r.name: r
			for r in frappe.get_all(
				"POS Order",
				filters={"name": ["in", order_names]},
				fields=["name", "guest_count", "bill_requested_at", "expected_departure"],
			)
		}
		if order_names
		else {}
	)
	counts = {name: {"active_item_count": 0, "pending_item_count": 0} for name in order_names}
	if order_names:
		for item in frappe.get_all(
			"POS Order Item",
			filters={"parent": ["in", order_names], "parenttype": "POS Order"},
			fields=["parent", "qty", "cancelled_qty", "sent_to_kitchen"],
		):
			if pos.get_active_order_item_qty(item.qty, item.cancelled_qty) > 0:
				counts[item.parent]["active_item_count"] += 1
				if not cint(item.sent_to_kitchen):
					counts[item.parent]["pending_item_count"] += 1
	for table in tables:
		table.reservations = [r for r in reservations if r.dining_table == table.name]
		# The floor must advertise a booking as soon as it is saved. A future
		# booking is visible without falsely marking the table occupied right now.
		table.has_upcoming_reservation = bool(table.reservations)
		table.reserved = any(
			get_datetime(r.starts_at) <= now_datetime() < get_datetime(r.ends_at) for r in table.reservations
		)
		for order in table.open_orders:
			order.update(meta.get(order["order"], {}))
			order.update(counts[order["order"]])
			due = order.get("expected_departure")
			order["departure_overdue"] = bool(due and get_datetime(due) <= now_datetime())
		table.service_status = (
			"bill-requested"
			if table.occupied and any(o.get("bill_requested_at") for o in table.open_orders)
			else "occupied"
			if table.occupied
			else "reserved"
			if table.has_upcoming_reservation
			else "available"
		)
	return tables


@frappe.whitelist()
def get_reservations(store, date=None):
	pos.require_pos_action("can_view_tables")
	pos.assert_store_access(store)
	filters = {"store": store}
	if date:
		start = get_datetime(date).replace(hour=0, minute=0, second=0, microsecond=0)
		filters.update({"starts_at": ["<", add_to_date(start, days=1)], "ends_at": [">", start]})
	else:
		filters.update({"status": ["in", ["Reserved", "Seated"]], "ends_at": [">", now_datetime()]})
	rows = frappe.get_all(
		"Table Reservation",
		filters=filters,
		fields=[
			"name",
			"dining_table",
			"guest_name",
			"phone",
			"guests",
			"starts_at",
			"ends_at",
			"notes",
			"status",
			"pos_order",
			"modified",
		],
		order_by="starts_at asc",
		limit_page_length=500,
	)
	from rms.reservation_payments import payment_summary
	for row in rows:
		row.deposit = payment_summary(row.name)
	return rows


@frappe.whitelist()
def get_reservation_tables(store, starts_at, ends_at, guests=1, exclude=None):
	pos.require_pos_action("can_view_tables")
	pos.assert_store_access(store)
	start, end = get_datetime(starts_at), get_datetime(ends_at)
	if not 15 * 60 <= (end - start).total_seconds() <= 12 * 3600:
		frappe.throw(_("Choose a reservation duration between 15 minutes and 12 hours."))
	if not math.isfinite(flt(guests)) or flt(guests) != cint(guests) or cint(guests) < 1:
		frappe.throw(_("Enter a positive whole number of guests."))
	if exclude:
		booking = frappe.get_doc("Table Reservation", exclude)
		pos.assert_store_access(booking.store)
		if booking.store != store:
			frappe.throw(_("Choose a reservation in this Store."))
	tables = pos.get_tables(store)
	for table in tables:
		booked = conflicting_reservations(table.name, start, end, exclude)
		reason = _("Too small") if cint(table.capacity) < cint(guests) else _("Reserved at this time") if booked else _("Guests are staying at this time") if visit_overlaps(table.name, start, end) else _("Busy now") if table.occupied and start <= now_datetime() else None
		table.bookable = not bool(reason)
		table.unavailable_reason = reason
		table.availability_note = _("Currently busy; confirm it will be free before arrival.") if table.occupied and not reason else None
	return tables


@frappe.whitelist()
def get_arrival_tables(reservation):
	pos.require_pos_action("can_view_tables")
	booking = frappe.get_doc("Table Reservation", reservation)
	pos.assert_store_access(booking.store)
	if booking.status != "Reserved" or get_datetime(booking.ends_at) <= now_datetime():
		frappe.throw(_("This reservation is no longer available for arrival. Edit its time or choose another booking."))
	tables = pos.get_tables(booking.store)
	for table in tables:
		reason = _("Too small") if cint(table.capacity) < cint(booking.guests) else _("Busy now") if table.occupied else _("Reserved at this time") if conflicting_reservations(table.name, now_datetime(), booking.ends_at, booking.name) else None
		table.bookable = not bool(reason)
		table.unavailable_reason = reason
	return tables


@frappe.whitelist(methods=["POST"])
def save_reservation(data, name=None, expected_modified=None):
	pos.require_pos_action("can_view_tables")
	data = frappe.parse_json(data)
	if not isinstance(data, dict):
		frappe.throw(_("Enter reservation details."))
	pos.assert_store_access(data.get("store"))
	deposit = data.get("deposit") or {}
	if deposit.get("request_id") and not name:
		existing = frappe.db.get_value("Reservation Payment", {"request_id": deposit["request_id"]}, "reservation")
		if existing:
			saved = frappe.get_doc("Table Reservation", existing)
			pos.assert_store_access(saved.store)
			return saved.as_dict()
	doc = (
		frappe.get_doc("Table Reservation", name, for_update=True)
		if name
		else frappe.new_doc("Table Reservation")
	)
	if name:
		pos.assert_store_access(doc.store)
		if doc.status != "Reserved":
			frappe.throw(_("Only an upcoming reservation can be changed."))
		check_modified(doc, expected_modified)
	for field in ("store", "dining_table", "guest_name", "phone", "guests", "starts_at", "ends_at", "notes"):
		doc.set(field, data.get(field))
	doc.save(ignore_permissions=True)
	if deposit:
		from rms.reservation_payments import transact
		transact(doc.name, "Receive", deposit.get("amount"), deposit.get("mode_of_payment"), deposit.get("request_id"))
	return doc.as_dict()


@frappe.whitelist(methods=["POST"])
def set_reservation_status(name, status, expected_modified=None):
	pos.require_pos_action("can_view_tables")
	doc = frappe.get_doc("Table Reservation", name, for_update=True)
	pos.assert_store_access(doc.store)
	check_modified(doc, expected_modified)
	if status not in ("Cancelled", "No Show") or doc.status != "Reserved":
		frappe.throw(_("Only an upcoming reservation can be cancelled or marked No Show."))
	if status == "No Show" and get_datetime(doc.starts_at) > now_datetime():
		frappe.throw(_("Mark No Show only after the reservation start time."))
	doc.status = status
	doc.save(ignore_permissions=True)
	return {"name": doc.name, "status": doc.status}


def check_modified(doc, value):
	if not value or get_datetime(value) != get_datetime(doc.modified):
		frappe.throw(
			_("The reservation changed. Refresh it before trying again."), frappe.TimestampMismatchError
		)


@frappe.whitelist(methods=["POST"])
def open_table(
	store,
	dining_table,
	guests=1,
	restaurant_brand=None,
	order_type=None,
	reservation=None,
	check_label=None,
	customer=None,
	expected_departure=None,
):
	pos.require_pos_action("can_checkout")
	pos.assert_store_access(store)
	session = pos.get_user_session(store)
	if not session or session.status != "Open" or session.user != frappe.session.user:
		frappe.throw(_("Open your Cashier Session before opening a table."))
	booking = frappe.get_doc("Table Reservation", reservation, for_update=True) if reservation else None
	if booking:
		pos.assert_store_access(booking.store)
		if booking.store != store or booking.status != "Reserved":
			frappe.throw(_("Choose an upcoming reservation for this table."))
		if get_datetime(booking.ends_at) <= now_datetime():
			frappe.throw(_("This reservation has ended. Edit its time before seating the guests."))
		guests = booking.guests
		expected_departure = booking.ends_at
	lock_tables([dining_table])
	table = frappe.db.get_value(
		"Dining Table", dining_table, ["store", "dining_area", "enabled", "capacity"], as_dict=True
	)
	if not table or not table.enabled or table.store != store:
		frappe.throw(_("Choose an enabled table in the same Store."))
	if (
		not math.isfinite(flt(guests))
		or flt(guests) != cint(guests)
		or cint(guests) < 1
		or cint(guests) > cint(table.capacity)
	):
		frappe.throw(_("Guest count must fit the table capacity."))
	assert_table_available(dining_table, reservation)
	from rms.table_service import assert_reservation_available
	assert_reservation_available(dining_table, reservation, expected_departure=expected_departure)
	brands = pos.get_brands(store)
	types = [
		r
		for r in pos.get_order_types(store)
		if r.get("require_table") and not r.get("require_external_reference")
	]
	brand = (
		restaurant_brand
		or next((r["name"] for r in brands if r.get("is_default")), None)
		or (brands[0]["name"] if brands else None)
	)
	type_name = order_type or (types[0]["name"] if types else None)
	if brand not in {r["name"] for r in brands} or type_name not in {r["name"] for r in types}:
		frappe.throw(_("Choose an allowed Brand and a table Order Type."))
	context = pos.get_pos_context(store)
	# Reuse the native POS customer check; cashiers can select customers without Desk access.
	customer_name = customer or context.get("customer")
	if customer_name:
		customer_name = pos._get_pos_customer(customer_name).name
	values = {
		"store": store,
		"cashier_session": session.name,
		"restaurant_brand": brand,
		"order_type": type_name,
		"dining_area": table.dining_area,
		"dining_table": dining_table,
		"customer": customer_name,
		"guest_count": cint(guests),
		"expected_departure": expected_departure,
		"check_label": check_label or (booking.guest_name[:60] if booking else None),
		"table_reservation": reservation,
	}
	doc = frappe.get_doc({"doctype": "POS Order", **values, "order_notes": booking.notes or "" if booking else "", "items": []})
	doc.insert(ignore_permissions=True)
	if booking:
		booking.dining_table = dining_table
		booking.status = "Seated"
		booking.pos_order = doc.name
		booking.save(ignore_permissions=True)
	return {"name": doc.name, "store": store, "dining_table": dining_table, "status": doc.status}


@frappe.whitelist(methods=["POST"])
def print_table_check(order_name):
	# Generate through the same permission-checked POS renderer before changing the status.
	pos.require_pos_action("can_reprint_receipts")
	doc = frappe.get_doc("POS Order", order_name, for_update=True)
	html = pos.get_open_order_check_print_html(order_name)
	if doc.status not in ("Confirmed", "In Preparation", "Ready"):
		frappe.throw(_("Refresh the order before printing its check."))
	doc.bill_requested_at = now_datetime()
	doc.save(ignore_permissions=True)
	return html


@frappe.whitelist(methods=["POST"])
def merge_table_orders(target_order, source_order):
	"""One check, retaining kitchen progress, original prices and source history."""
	pos.require_pos_action("can_merge_orders")
	if target_order == source_order:
		frappe.throw(_("Choose two different orders."))
	# A consistent lock order prevents two registers merging the same pair twice.
	orders = {
		name: frappe.get_doc("POS Order", name, for_update=True)
		for name in sorted({target_order, source_order})
	}
	target, source = orders[target_order], orders[source_order]
	for order in (target, source):
		pos.assert_store_access(order.store)
		pos.require_order_scope(order)
		pos.assert_items_confirmed(order)
		session = pos.get_user_session(order.store)
		if not session or session.status != "Open" or order.cashier_session != session.name:
			frappe.throw(_("Merge checks from your own open Cashier Session."), frappe.PermissionError)
		if order.status not in ACTIVE_ORDER_STATUSES:
			frappe.throw(_("Only active unpaid checks can be merged."))
		if order.payments or order.pos_invoice or order.guest_checks:
			frappe.throw(_("Checks with payments or allocated guest bills cannot be merged."))
	for field in (
		"store",
		"cashier_session",
		"restaurant_brand",
		"order_type",
		"customer",
		"external_reference",
		"sales_taxes_and_charges_template",
		"discount_type",
		"discount_scope",
		"discount_value",
		"discount_reason",
	):
		if (target.get(field) or None) != (source.get(field) or None):
			frappe.throw(
				_("Choose checks with the same Store, Brand, customer, Order Type and discount settings.")
			)
	if not target.dining_table or not source.dining_table:
		frappe.throw(_("Choose two table orders."))
	lock_tables([target.dining_table, source.dining_table])
	from rms.table_service import merging_snapshot
	from copy import deepcopy

	mapping = {}
	for row in source.items:
		values = deepcopy(row.as_dict())
		for key in (
			"name",
			"parent",
			"parenttype",
			"parentfield",
			"idx",
			"creation",
			"modified",
			"owner",
			"modified_by",
			"docstatus",
		):
			values.pop(key, None)
		values["name"] = frappe.generate_hash(length=10)
		values["__islocal"] = 1
		mapping[row.name] = values["name"]
		appended = target.append("items", values)
		# Child Links on cancellation history and kitchen tickets need a stable ID.
		# The parent save below validates the snapshot; any failure rolls this insert back.
		appended.db_insert()
	for row in source.item_cancellations or []:
		values = deepcopy(row.as_dict())
		for key in (
			"name",
			"parent",
			"parenttype",
			"parentfield",
			"idx",
			"creation",
			"modified",
			"owner",
			"modified_by",
			"docstatus",
		):
			values.pop(key, None)
		values["pos_order_item"] = mapping.get(values.get("pos_order_item"), values.get("pos_order_item"))
		values["merged_from"] = row.get("merged_from") or row.name
		target.append("item_cancellations", values)
	if flt(target.discount_value) and target.discount_type == "Amount":
		target.discount_value = flt(target.discount_value) + flt(source.discount_value)
	target.guest_count = cint(target.guest_count) + cint(source.guest_count)
	if source.order_notes:
		target.order_notes = "\n".join(filter(None, [target.order_notes, source.order_notes]))[:2000]
	was_confirmed = any(o.status in ("Confirmed", "In Preparation", "Ready") for o in (target, source))
	tickets = frappe.get_all(
		"Kitchen Ticket",
		filters={"pos_order": ["in", [target.name, source.name]]},
		fields=["name", "pos_order", "status"],
		order_by="name asc",
	)
	if was_confirmed:
		active = [t.status for t in tickets if t.status != "Cancelled"]
		target.status = (
			"Ready"
			if active
			and all(s in ("Ready", "Picked") for s in active)
			and all(r.sent_to_kitchen for r in target.items)
			else "In Preparation"
			if any(s in ("Started", "Ready", "Picked") for s in active)
			else "Confirmed"
		)
	target.bill_requested_at = None
	with merging_snapshot(target):
		target.save(ignore_permissions=True)
	# Repoint existing tickets; do not confirm or print their items a second time.
	for row in tickets:
		if row.pos_order != source.name:
			continue
		ticket = frappe.get_doc("Kitchen Ticket", row.name, for_update=True)
		ticket.pos_order = target.name
		for item in ticket.items:
			item.pos_order_item = mapping[item.pos_order_item]
		ticket.save(ignore_permissions=True)
	source.merged_into = target.name
	source.status = "Cancelled"
	source.save(ignore_permissions=True)
	message = _("Order {0} was merged into {1} by {2}.").format(source.name, target.name, frappe.session.user)
	target.add_comment("Info", message)
	source.add_comment("Info", message)
	# Existing kitchen output needs an updated table/check reference, not new food tickets.
	for area in {
		r.preparation_area
		for r in frappe.get_all(
			"Kitchen Ticket", filters={"pos_order": target.name}, fields=["preparation_area"]
		)
	}:
		config = frappe.get_doc("Preparation Area", area)
		if config.has_printer and config.print_device:
			frappe.get_doc(
				{
					"doctype": "Print Dispatch Job",
					"store": target.store,
					"preparation_area": area,
					"print_device": config.print_device,
					"document_type": "POS Order",
					"document_name": target.name,
					"idempotency_key": frappe.generate_hash(
						f"MERGE|{target.name}|{source.name}|{area}", length=32
					),
					"status": "Queued",
					"payload": _("CHECKS MERGED\nFrom: {0}\nInto: {1}\nTable: {2}").format(
						source.name, target.name, target.dining_table
					),
				}
			).insert(ignore_permissions=True)
	return {
		"name": target.name,
		"merged_order": source.name,
		"dining_table": target.dining_table,
		"grand_total": target.grand_total,
	}


@frappe.whitelist()
def get_table_order(order_name):
	result = pos.get_open_order_overview(order_name)
	doc = frappe.get_doc("POS Order", order_name)
	from rms.pos_rounding import round_pos_payable

	method = frappe.db.get_value("Restaurant Brand", doc.restaurant_brand, "pos_rounding_method") or "Nearest"
	checks = pos.get_guest_checks(order_name)["guest_checks"] if doc.guest_checks else []
	payable = (
		sum(flt(row["payable_total"]) for row in checks)
		if checks
		else flt(round_pos_payable(doc.grand_total, method), 2)
	)
	paid = sum(flt(row["payable_total"]) for row in checks if row["status"] == "Paid")
	result.update(
		{
			"guest_count": doc.guest_count,
			"bill_requested_at": doc.bill_requested_at,
			"payable_total": payable,
			"paid_total": paid,
			"outstanding_total": max(0, payable - paid),
			"guest_checks": checks,
		}
	)
	for item in result["items"]:
		item["must_be_whole_number"] = (
			bool(frappe.get_cached_value("UOM", item["uom"], "must_be_whole_number"))
			if item.get("uom")
			else False
		)
	return result


@frappe.whitelist(methods=["POST"])
def update_pending_item(order_name, item_name, qty, expected_modified):
	"""Edit a floor addition through the same save path as the native cart."""
	pos.require_pos_action("can_checkout")
	doc = pos.get_owned_order(order_name, ACTIVE_ORDER_STATUSES)
	if not doc.dining_table or doc.guest_checks or doc.payments or doc.pos_invoice:
		frappe.throw(_("This check cannot be edited from the dining floor."))
	if not expected_modified or get_datetime(expected_modified) != get_datetime(doc.modified):
		frappe.throw(_("The order changed. Refresh it before trying again."), frappe.TimestampMismatchError)
	row = next((row for row in doc.items if row.name == item_name), None)
	try:
		quantity = float(qty)
	except (TypeError, ValueError):
		frappe.throw(_("Enter a valid quantity."))
	if not row or row.sent_to_kitchen or flt(row.cancelled_qty):
		frappe.throw(_("Confirmed items must be voided; only unconfirmed items can be removed or edited."))
	if not math.isfinite(quantity) or quantity < 0:
		frappe.throw(_("Enter a valid quantity."))
	if row.uom and frappe.get_cached_value("UOM", row.uom, "must_be_whole_number") and quantity % 1:
		frappe.throw(_("Enter a whole quantity for this item."))
	payload = {
		field: doc.get(field)
		for field in (
			"store",
			"restaurant_brand",
			"order_type",
			"customer",
			"external_reference",
			"dining_area",
			"dining_table",
			"discount_type",
			"discount_scope",
			"discount_value",
			"discount_reason",
			"order_notes",
		)
	}
	payload["order_notes"] = doc.order_notes or ""
	payload.update(name=doc.name, expected_modified=str(doc.modified), edit_pending_items=True, items=[])
	for item in doc.items:
		if item.sent_to_kitchen or (item.name == item_name and not quantity):
			continue
		payload["items"].append(
			dict(
				order_item_name=item.name,
				selling_product=item.selling_product,
				option_parent=item.option_parent,
				qty=quantity if item.name == item_name else item.qty,
				notes=item.notes,
				modifiers=frappe.parse_json(item.modifiers) or [],
			)
		)
	result = pos.save_order(payload)
	if result.get("conflict"):
		frappe.throw(_("The order changed. Refresh it before trying again."), frappe.TimestampMismatchError)
	return get_table_order(doc.name)


def copy_child_snapshot(row):
	values = deepcopy(row.as_dict())
	for key in (
		"name",
		"parent",
		"parenttype",
		"parentfield",
		"idx",
		"creation",
		"modified",
		"owner",
		"modified_by",
		"docstatus",
	):
		values.pop(key, None)
	return values


def resize_item_snapshot(row, qty):
	"""Recipe component quantities are totals; prices and modifier quantities are per unit."""
	from rms.snapshots import parse_json_rows, serialize_json_rows
	from rms.rms.doctype.pos_order.pos_order import calculate_order_item_amount

	ratio = flt(qty) / flt(row.qty)
	row.recipe_snapshot = serialize_json_rows(
		[
			dict(component, qty=flt(component.qty) * ratio)
			for component in parse_json_rows(row.recipe_snapshot)
		]
	)
	row.qty = qty
	row.amount = calculate_order_item_amount(
		qty, row.selling_price, parse_json_rows(row.modifiers), row.cancelled_qty
	)


def kitchen_status_for_items(items):
	statuses = [
		row.get("status") or "Pending"
		for row in items
		if flt(row.get("qty")) > flt(row.get("cancelled_qty")) and row.get("status") != "Cancelled"
	]
	if not statuses:
		return "Cancelled"
	if all(status == "Picked" for status in statuses):
		return "Picked"
	if all(status in ("Ready", "Picked") for status in statuses):
		return "Ready"
	return "Started" if any(status in ("Started", "Ready", "Picked") for status in statuses) else "Pending"


@frappe.whitelist(methods=["POST"])
def split_table_order(order_name, dining_table, quantities, guests, expected_modified):
	frappe.db.savepoint("rms_split_table")
	try:
		return _split_table_order(order_name, dining_table, quantities, guests, expected_modified)
	except Exception:
		frappe.db.rollback(save_point="rms_split_table")
		raise


def _split_table_order(order_name, dining_table, quantities, guests, expected_modified):
	"""Move confirmed quantities to a free table, retaining preparation and financial snapshots."""
	pos.require_pos_action("can_split_orders")
	pos.require_pos_action("can_checkout")
	source = pos.get_owned_order(order_name, ("Confirmed", "In Preparation", "Ready"))
	pos.assert_items_confirmed(source)
	if not source.dining_table or not dining_table or source.dining_table == dining_table:
		frappe.throw(_("Choose a different available destination table."))
	if source.payments or source.pos_invoice or source.guest_checks:
		frappe.throw(_("Checks with payments or allocated guest bills cannot be split between tables."))
	if not expected_modified or get_datetime(expected_modified) != get_datetime(source.modified):
		frappe.throw(_("The order changed. Refresh it before trying again."), frappe.TimestampMismatchError)
	quantities = frappe.parse_json(quantities)
	if not isinstance(quantities, dict) or not quantities:
		frappe.throw(_("Choose items and quantities to move to the other table."))
	by_name = {row.name: row for row in source.items}
	selected = {}
	for name, value in quantities.items():
		row = by_name.get(name)
		qty = flt(value)
		if (
			not row
			or not row.sent_to_kitchen
			or not math.isfinite(qty)
			or qty <= 0
			or qty > pos.get_active_order_item_qty(row.qty, row.cancelled_qty)
		):
			frappe.throw(_("Each split quantity must fit the remaining confirmed quantity."))
		if row.uom and frappe.get_cached_value("UOM", row.uom, "must_be_whole_number") and qty % 1:
			frappe.throw(_("Enter a whole quantity for this item."))
		selected[name] = qty
	if not any(
		pos.get_active_order_item_qty(row.qty, row.cancelled_qty) - selected.get(row.name, 0) > 0.000001
		for row in source.items
	):
		frappe.throw(
			_("Leave at least one item on the source table. Use Move table to move the whole order.")
		)
	lock_tables([source.dining_table, dining_table])
	table = frappe.db.get_value(
		"Dining Table", dining_table, ["store", "dining_area", "enabled", "capacity"], as_dict=True
	)
	if not table or not table.enabled or table.store != source.store:
		frappe.throw(_("Choose an enabled table in the same Store."))
	assert_table_available(dining_table)
	party = flt(guests)
	if not math.isfinite(party) or party != cint(party) or party < 1 or party > cint(table.capacity):
		frappe.throw(_("Guest count must fit the table capacity."))
	if cint(source.guest_count) > 1 and party >= cint(source.guest_count):
		frappe.throw(_("Leave at least one guest on the source table."))
	from rms.table_service import merging_snapshot

	new = frappe.new_doc("POS Order")
	for field in (
		"store",
		"cashier_session",
		"restaurant_brand",
		"order_type",
		"customer",
		"external_reference",
		"sales_taxes_and_charges_template",
		"discount_type",
		"discount_scope",
		"discount_value",
		"discount_reason",
		"order_notes",
	):
		new.set(field, source.get(field))
	new.expected_departure = source.get("expected_departure")
	new.dining_table, new.dining_area, new.guest_count = dining_table, table.dining_area, cint(party)
	new.status = "Open"
	original_total, original_subtotal = flt(source.grand_total), flt(source.subtotal)
	mapping = {}
	for row in list(source.items):
		qty = selected.get(row.name)
		if not qty:
			continue
		appended = new.append("items", copy_child_snapshot(row))
		appended.cancelled_qty = 0
		resize_item_snapshot(appended, qty)
		mapping[row.name] = appended
		remaining = flt(row.qty) - qty
		if remaining > 0.000001:
			resize_item_snapshot(row, remaining)
		else:
			source.remove(row)
	if source.discount_type == "Amount" and flt(source.discount_value):
		new.discount_value = flt(
			flt(source.discount_value) * sum(flt(row.amount) for row in new.items) / original_subtotal, 2
		)
		source.discount_value = flt(source.discount_value) - new.discount_value
	# Only this server context can accept the exact snapshots constructed above.
	with merging_snapshot(new):
		new.insert(ignore_permissions=True)
	new.status = source.status
	with merging_snapshot(new):
		new.save(ignore_permissions=True)
	source.guest_count = max(1, cint(source.guest_count) - cint(party))
	source.bill_requested_at = None
	with merging_snapshot(source):
		source.save(ignore_permissions=True)
	if abs(flt(source.grand_total) + flt(new.grand_total) - original_total) > 0.02:
		frappe.throw(
			_(
				"This check has fixed charges that cannot be split between tables. Split its guest bills instead."
			)
		)
	# Redistribute existing kitchen quantities and progress, without confirming again.
	for name in frappe.get_all(
		"Kitchen Ticket",
		filters={"pos_order": source.name, "is_item_cancellation_notice": 0},
		pluck="name",
		order_by="name asc",
	):
		ticket = frappe.get_doc("Kitchen Ticket", name, for_update=True)
		moved = []
		for line in list(ticket.items):
			qty = min(selected.get(line.pos_order_item, 0), max(0, flt(line.qty) - flt(line.cancelled_qty)))
			if not qty:
				continue
			values = copy_child_snapshot(line)
			values.update(pos_order_item=mapping[line.pos_order_item].name, qty=qty, cancelled_qty=0)
			moved.append(values)
			line.qty = flt(line.qty) - qty
			if line.qty <= 0.000001:
				ticket.remove(line)
		if not moved:
			continue
		if not ticket.items:
			ticket.pos_order = new.name
			ticket.set("items", moved)
			ticket.status = kitchen_status_for_items(moved)
			ticket.save(ignore_permissions=True)
		else:
			ticket.status = kitchen_status_for_items(ticket.items)
			ticket.save(ignore_permissions=True)
			child = frappe.get_doc(
				dict(
					doctype="Kitchen Ticket",
					store=ticket.store,
					pos_order=new.name,
					preparation_area=ticket.preparation_area,
					sent_at=ticket.sent_at,
					items=moved,
				)
			)
			child.insert(ignore_permissions=True)
			child.status = kitchen_status_for_items(moved)
			child.save(ignore_permissions=True)
			child.db_set(
				{
					"sent_at": ticket.sent_at,
					"started_at": ticket.started_at
					if child.status in ("Started", "Ready", "Picked")
					else None,
					"ready_at": ticket.ready_at if child.status in ("Ready", "Picked") else None,
					"picked_at": ticket.picked_at if child.status == "Picked" else None,
				},
				update_modified=False,
			)
	for order in (source, new):
		tickets = frappe.get_all(
			"Kitchen Ticket",
			filters={
				"pos_order": order.name,
				"is_item_cancellation_notice": 0,
				"status": ["!=", "Cancelled"],
			},
			pluck="status",
		)
		order.status = (
			"Ready"
			if tickets and all(status in ("Ready", "Picked") for status in tickets)
			else "In Preparation"
			if any(status in ("Started", "Ready", "Picked") for status in tickets)
			else "Confirmed"
		)
		with merging_snapshot(order):
			order.save(ignore_permissions=True)
	message = _("Selected quantities were split from {0} ({1}) into {2} ({3}) by {4}.").format(
		source.name, source.dining_table, new.name, new.dining_table, frappe.session.user
	)
	for order in (source, new):
		order.add_comment("Info", message)
	for area_name in set(
		frappe.get_all("Kitchen Ticket", filters={"pos_order": new.name}, pluck="preparation_area")
	):
		area = frappe.get_doc("Preparation Area", area_name)
		if area.has_printer and area.print_device:
			frappe.get_doc(
				dict(
					doctype="Print Dispatch Job",
					store=source.store,
					preparation_area=area.name,
					print_device=area.print_device,
					document_type="POS Order",
					document_name=new.name,
					idempotency_key=frappe.generate_hash(
						f"TABLE-SPLIT|{source.name}|{new.name}|{area.name}", length=32
					),
					status="Queued",
					payload=_("TABLE CHECK SPLIT\n{0}").format(message),
				)
			).insert(ignore_permissions=True)
	return {
		"name": new.name,
		"source_order": source.name,
		"dining_table": new.dining_table,
		"grand_total": new.grand_total,
	}


@frappe.whitelist(methods=["POST"])
def close_empty_table(order_name):
	pos.require_pos_action("can_checkout")
	doc = pos.get_owned_order(order_name, ("Open", "Pending Confirmation"))
	if doc.items or doc.payments or doc.guest_checks or doc.get("pos_invoice"):
		frappe.throw(
			_(
				"Only an empty unpaid table can be closed here. Use payment or order cancellation for an existing check."
			)
		)
	if not doc.dining_table:
		frappe.throw(_("Choose an empty table order."))
	doc.status = "Cancelled"
	doc.save(ignore_permissions=True)
	return {"name": doc.name, "status": doc.status}


@frappe.whitelist()
def get_merge_candidates(order_name):
	pos.require_pos_action("can_merge_orders")
	order = pos.get_owned_order(order_name, ACTIVE_ORDER_STATUSES)
	pos.assert_items_confirmed(order)
	if order.payments or order.guest_checks or order.pos_invoice:
		return []
	filters = {
		"name": ["!=", order.name],
		"cashier_session": order.cashier_session,
		"status": ["in", ACTIVE_ORDER_STATUSES],
		"dining_table": ["is", "set"],
		"pos_invoice": ["is", "not set"],
	}
	for field in (
		"store",
		"restaurant_brand",
		"order_type",
		"customer",
		"external_reference",
		"sales_taxes_and_charges_template",
		"discount_type",
		"discount_scope",
		"discount_value",
		"discount_reason",
	):
		value = order.get(field)
		filters[field] = value if value is not None and value != "" else ["is", "not set"]
	rows = frappe.get_all(
		"POS Order",
		filters=filters,
		fields=[
			"name",
			"store",
			"cashier_session",
			"restaurant_brand",
			"order_type",
			"dining_table",
			"check_label",
			"grand_total",
			"status",
		],
		order_by="creation asc",
	)
	names = [row.name for row in rows]
	blocked = set()
	if names:
		for field in ("payments", "guest_checks"):
			blocked.update(
				frappe.get_all(
					frappe.get_meta("POS Order").get_field(field).options,
					filters={"parent": ["in", names], "parenttype": "POS Order"},
					pluck="parent",
				)
			)
		for item in frappe.get_all(
			"POS Order Item",
			filters={"parent": ["in", names], "parenttype": "POS Order", "sent_to_kitchen": 0},
			fields=["parent", "qty", "cancelled_qty"],
		):
			if pos.get_active_order_item_qty(item.qty, item.cancelled_qty) > 0:
				blocked.add(item.parent)
	return [row for row in rows if row.name not in blocked]
