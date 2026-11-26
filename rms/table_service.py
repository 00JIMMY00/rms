"""Table availability and reservation rules shared by POS and the dining floor."""

import math
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, now_datetime, add_to_date

ACTIVE_ORDER_STATUSES = ("Open", "Pending Confirmation", "Confirmed", "In Preparation", "Ready")


def lock_tables(names):
	for name in sorted({name for name in names if name}):
		frappe.db.sql("select name from `tabDining Table` where name=%s for update", name)


def current_exists(doctype, filters):
	# A locking read sees commits made while waiting for the table lock, even under
	# MariaDB's repeatable-read isolation. A normal EXISTS can retain an old snapshot.
	return bool(frappe.db.get_value(doctype, filters, "name", for_update=True))


def conflicting_reservations(table, start, end=None, exclude=None, lock=False):
	"""Seated guests occupy from their actual order creation, including early arrivals."""
	return frappe.db.sql("""
		select r.name, r.starts_at, r.ends_at, r.guest_name
		from `tabTable Reservation` r
		left join `tabPOS Order` o on o.name=r.pos_order
		where r.dining_table=%(table)s and r.name!=%(exclude)s
		and r.status in ('Reserved', 'Seated') and r.ends_at>%(start)s
		""" + ("and (case when r.status='Seated' then coalesce(o.creation, r.starts_at) else r.starts_at end)<%(end)s " if end else "") +
		"order by r.starts_at asc" + (" for update" if lock else ""),
		{"table": table, "start": start, "end": end, "exclude": exclude or ""}, as_dict=True)


def visit_overlaps(table, start, end, lock=False):
	return bool(frappe.db.get_value("POS Order", {
		"dining_table": table, "status": ["in", ACTIVE_ORDER_STATUSES],
		"expected_departure": [">", start], "creation": ["<", end],
	}, "name", for_update=lock))


def active_table_orders(table, exclude=None):
	return frappe.db.get_values(
		"POS Order",
		{
			"dining_table": table,
			"name": ["!=", exclude or ""],
			"status": ["in", ACTIVE_ORDER_STATUSES],
		},
		["name", "table_check_group", "check_label"],
		as_dict=True,
		for_update=True,
	)


def validate_reservation_values(doc):
	table = frappe.db.get_value(
		"Dining Table", doc.dining_table, ["store", "enabled", "capacity"], as_dict=True
	)
	if not table or not table.enabled or table.store != doc.store:
		frappe.throw(_("Choose an enabled table in the same Store."))
	if not isinstance(doc.guest_name, str) or not doc.guest_name.strip() or len(doc.guest_name) > 140:
		frappe.throw(_("Enter a guest name of up to 140 characters."))
	if not isinstance(doc.phone, str) or not doc.phone.strip() or len(doc.phone) > 40:
		frappe.throw(_("Enter a contact phone number of up to 40 characters."))
	if (
		not math.isfinite(flt(doc.guests))
		or flt(doc.guests) != cint(doc.guests)
		or cint(doc.guests) < 1
		or (doc.status == "Reserved" and cint(doc.guests) > cint(table.capacity))
	):
		frappe.throw(_("Guest count must fit the table capacity."))
	if not doc.starts_at or not doc.ends_at or get_datetime(doc.ends_at) <= get_datetime(doc.starts_at):
		frappe.throw(_("Reservation end time must be after its start time."))
	if not isinstance(doc.notes, (str, type(None))) or len(doc.notes or "") > 2000:
		frappe.throw(_("Enter a note of up to 2000 characters."))
	doc.guest_name, doc.phone = doc.guest_name.strip(), doc.phone.strip()


def current_reservations(store):
	if not frappe.db.exists("DocType", "Table Reservation"):
		return []
	return frappe.get_all(
		"Table Reservation",
		filters={"store": store, "status": "Reserved", "ends_at": [">", now_datetime()]},
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
			"modified",
		],
		order_by="starts_at asc",
	)


def assert_table_available(table, reservation=None, order_name=None):
	"""Call with the Dining Table row locked; all till writers share this check."""
	if current_exists(
		"POS Order",
		{"dining_table": table, "name": ["!=", order_name or ""], "status": ["in", ACTIVE_ORDER_STATUSES]},
	):
		frappe.throw(_("This table already has an active order."))
	if current_exists(
		"Table Reservation",
		{
			"dining_table": table,
			"name": ["!=", reservation or ""],
			"status": "Reserved",
			"starts_at": ["<=", now_datetime()],
			"ends_at": [">", now_datetime()],
		},
	):
		frappe.throw(_("This table is reserved now. Seat its reservation or choose another table."))


def finish_reservation(order, method=None):
	if order.status not in (*ACTIVE_ORDER_STATUSES, "Paid", "Cancelled") or not frappe.db.exists(
		"DocType", "Table Reservation"
	):
		return
	from rms.streaming_replica import upstream

	if upstream(order):
		return
	for name in frappe.get_all(
		"Table Reservation", filters={"pos_order": order.name, "status": "Seated"}, pluck="name"
	):
		reservation = frappe.get_doc("Table Reservation", name)
		if order.get("merged_into"):
			reservation.pos_order = order.merged_into
			reservation.dining_table = frappe.db.get_value("POS Order", order.merged_into, "dining_table")
		elif order.status in ACTIVE_ORDER_STATUSES:
			if reservation.dining_table == order.dining_table:
				continue
			reservation.dining_table = order.dining_table
		else:
			reservation.status = "Completed" if order.status == "Paid" else "Cancelled"
		reservation.save(ignore_permissions=True)


def reservation_permission_query(user=None):
	from rms.api.pos import _user_has_store_access

	user = user or frappe.session.user
	stores = [s for s in frappe.get_all("Store", pluck="name") if _user_has_store_access(user, s)]
	return (
		"`tabTable Reservation`.store in ({})".format(",".join(frappe.db.escape(s) for s in stores))
		if stores
		else "1=0"
	)


def reservation_has_permission(doc, user=None, permission_type=None, ptype=None):
	from rms.api.pos import _user_has_store_access
	from rms.streaming_replica import upstream

	if upstream(doc):
		return True
	return _user_has_store_access(user or frappe.session.user, doc.store)


def assert_reservation_available(table, reservation=None, order_name=None, expected_departure=None):
	if not frappe.db.exists("DocType", "Table Reservation"):
		return
	# Existing orders keep their table when a later reservation starts.
	if order_name and frappe.db.get_value("POS Order", order_name, "dining_table") == table:
		return
	if current_exists(
		"Table Reservation",
		{
			"dining_table": table,
			"name": ["!=", reservation or ""],
			"status": "Reserved",
			"starts_at": ["<=", now_datetime()],
			"ends_at": [">", now_datetime()],
		},
	):
		frappe.throw(_("This table is reserved now. Seat its reservation or choose another table."))
	if expected_departure and get_datetime(expected_departure) <= now_datetime():
		frappe.throw(_("Choose a departure time after now."))
	conflicts = conflicting_reservations(table, now_datetime(), expected_departure or add_to_date(now_datetime(), hours=12), reservation, lock=True)
	if conflicts:
		if not expected_departure:
			frappe.throw(_("This table has an upcoming reservation. Open it from Tables and choose a stay that ends before the booking."))
		frappe.throw(_("This stay overlaps another reservation. Shorten the visit or choose another table."))


# Only this server context can carry saved item snapshots into a combined check.
# A browser-posted Document.flags value cannot enter this context.
_merge_snapshot = ContextVar("rms_merge_snapshot", default=None)


@contextmanager
def merging_snapshot(doc):
	values = deepcopy(doc.as_dict())
	token = _merge_snapshot.set((doc, values))
	try:
		yield
	finally:
		_merge_snapshot.reset(token)


def validate_merge_snapshot(doc):
	context = _merge_snapshot.get()
	if not context or context[0] is not doc:
		return False
	# Frappe stamps modified/owner before validate; every business field is fixed.
	expected = context[1]
	for field in (
		"store",
		"cashier_session",
		"restaurant_brand",
		"order_type",
		"customer",
		"external_reference",
		"dining_table",
		"dining_area",
		"check_label",
		"guest_count",
		"status",
		"discount_type",
		"discount_value",
		"discount_scope",
		"discount_reason",
	):
		if doc.get(field) != expected.get(field):
			frappe.throw(_("Combined check details changed during the merge."))
	for field in ("items", "guest_checks", "item_cancellations"):
		fields = [
			f.fieldname
			for f in frappe.get_meta(doc.meta.get_field(field).options).fields
			if f.fieldtype not in ("Section Break", "Column Break")
		]

		def snapshot(rows):
			return [{key: row.get(key) for key in fields} for row in rows or []]

		if snapshot(doc.get(field)) != snapshot(expected.get(field)):
			frappe.throw(_("Combined check item snapshots changed during the merge."))
	doc.validate_context()
	doc.recalculate_order_totals()
	doc.validate_payment_state()
	return True
