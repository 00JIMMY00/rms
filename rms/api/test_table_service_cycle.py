"""Real ERPNext dining cycle; run only on an isolated site with allow_tests enabled."""

import unittest

import frappe
from frappe.utils import now_datetime, add_to_date
from rms.api import pos, table_service as api
from rms.demo import ensure


class TestTableServiceCycle(unittest.TestCase):
	def setUp(self):
		if not frappe.conf.get("allow_tests") or frappe.conf.get("arab_streaming_site_role") == "Slave":
			self.skipTest("Requires a test site that can provision a local Store")
		self.user = frappe.session.user
		frappe.set_user("Administrator")
		self.addCleanup(self.cleanup_site)

	def cleanup_site(self):
		frappe.db.rollback()
		frappe.set_user(self.user)

	def test_reserve_open_confirm_merge_transfer_split_pay_and_close(self):
		company = frappe.get_doc(
			{
				"doctype": "Company",
				"company_name": "RMS Floor Cycle Test",
				"abbr": "RFCT",
				"country": "Egypt",
				"default_currency": "EGP",
				"create_chart_of_accounts_based_on": "Standard Template",
				"chart_of_accounts": "Standard",
			}
		).insert(ignore_permissions=True)
		C = company.name
		cash_account = frappe.db.get_value(
			"Account", {"company": C, "account_type": "Cash", "is_group": 0}, "name"
		)
		warehouse = frappe.db.get_value("Warehouse", {"company": C, "is_group": 0}, "name")
		parent_tax = frappe.db.get_value(
			"Account", {"company": C, "account_type": "Tax", "is_group": 1}, "name"
		)
		tax_account = (
			frappe.get_doc(
				{
					"doctype": "Account",
					"company": C,
					"account_name": "Floor VAT",
					"parent_account": parent_tax,
					"account_type": "Tax",
					"is_group": 0,
				}
			)
			.insert(ignore_permissions=True)
			.name
		)
		taxes = (
			frappe.get_doc(
				{
					"doctype": "Sales Taxes and Charges Template",
					"title": "Floor Cycle VAT",
					"company": C,
					"taxes": [
						{
							"charge_type": "On Net Total",
							"account_head": tax_account,
							"rate": 14,
							"description": "VAT",
						}
					],
				}
			)
			.insert(ignore_permissions=True)
			.name
		)
		cash = ensure(
			"Mode of Payment",
			"Floor Cash",
			{
				"mode_of_payment": "Floor Cash",
				"type": "Cash",
				"accounts": [{"company": C, "default_account": cash_account}],
			},
		).name
		customer = ensure(
			"Customer",
			"Floor Test Guest",
			{
				"customer_name": "Floor Test Guest",
				"customer_type": "Individual",
				"customer_group": "Individual",
				"territory": "All Territories",
			},
		).name
		price_list = ensure(
			"Price List",
			"Floor Test Prices",
			{"price_list_name": "Floor Test Prices", "currency": "EGP", "selling": 1, "enabled": 1},
		).name
		profile = ensure(
			"POS Profile",
			"Floor Test Register",
			{
				"name": "Floor Test Register",
				"company": C,
				"warehouse": warehouse,
				"currency": "EGP",
				"customer": customer,
				"selling_price_list": price_list,
				"income_account": company.default_income_account,
				"expense_account": company.default_expense_account,
				"cost_center": company.cost_center,
				"write_off_account": company.round_off_account,
				"write_off_cost_center": company.cost_center,
				"write_off_limit": 1,
				"account_for_change_amount": cash_account,
				"update_stock": 0,
				"ignore_pricing_rule": 1,
				"payments": [{"mode_of_payment": cash, "default": 1}],
			},
		).name
		kind = ensure(
			"Order Type",
			"Floor Test Dine In",
			{
				"title": "Floor Test Dine In",
				"enabled": 1,
				"require_table": 1,
				"accounts": [
					{
						"company": C,
						"income_account": company.default_income_account,
						"cost_of_goods_sold_account": company.default_expense_account,
					}
				],
			},
		).name
		brand = ensure("Restaurant Brand", "Floor Cycle Brand", {"title": "Floor Cycle Brand", "enabled": 1})
		store = ensure(
			"Store",
			"Floor Test Store",
			{
				"title": "Floor Test Store",
				"store_code": "FLOORTEST",
				"company": C,
				"pos_profile": profile,
				"default_warehouse": warehouse,
				"enabled": 1,
				"brands": [{"restaurant_brand": brand.name, "is_default": 1}],
			},
		)
		store.set("order_type_taxes", [{"order_type": kind, "sales_taxes_and_charges_template": taxes}])
		store.save(ignore_permissions=True)
		area = ensure(
			"Dining Area", "Floor Test Hall", {"title": "Floor Test Hall", "store": store.name, "enabled": 1}
		).name
		tables = [
			ensure(
				"Dining Table",
				f"Floor Test T{i}",
				{
					"title": f"Floor Test T{i}",
					"store": store.name,
					"dining_area": area,
					"capacity": 8,
					"enabled": 1,
				},
			).name
			for i in range(1, 6)
		]
		kitchen = ensure(
			"Preparation Area",
			"Floor Test Kitchen",
			{
				"title": "Floor Test Kitchen",
				"store": store.name,
				"enabled": 1,
				"has_kds": 1,
				"has_printer": 0,
			},
		).name
		store.default_preparation_area = kitchen
		store.save(ignore_permissions=True)
		category = ensure(
			"Product Category",
			"Floor Test Category",
			{"title": "Floor Test Category", "enabled": 1, "is_group": 0, "item_group": "Products"},
		).name
		menu = ensure(
			"Store Menu",
			"Floor Test Menu",
			{
				"title": "Floor Test Menu",
				"restaurant_brand": brand.name,
				"enabled": 1,
				"categories": [{"product_category": category}],
			},
		).name
		if menu not in [r.store_menu for r in brand.menus]:
			brand.append("menus", {"store_menu": menu})
			brand.save(ignore_permissions=True)
		product = ensure(
			"Selling Product",
			"Floor Test Tea",
			{
				"title": "Floor Test Tea",
				"product_category": category,
				"uom": "Nos",
				"enabled": 1,
				"selling_price": 100,
				"maintain_stock": 0,
			},
		).name
		pos.open_session(store.name)
		# Reservation conflict, edit and arrival into an actual empty order.
		start = now_datetime()
		end = add_to_date(start, hours=2)
		data = dict(
			store=store.name,
			dining_table=tables[0],
			guest_name="Test guest",
			phone="01000000000",
			guests=2,
			starts_at=str(start),
			ends_at=str(end),
			notes="No nuts",
		)
		from rms.reservation_payments import transact, payment_summary, DEPOSIT_METHOD
		booking = api.save_reservation({**data, "deposit": {"amount":150,"mode_of_payment":cash,"request_id":"cycle-booking-deposit"}})
		assert api.save_reservation({**data, "deposit": {"amount":150,"mode_of_payment":cash,"request_id":"cycle-booking-deposit"}})["name"] == booking["name"]
		assert payment_summary(booking["name"])["balance"] == 150
		assert len(payment_summary(booking["name"])["transactions"]) == 1
		availability = api.get_reservation_tables(store.name,str(start),str(end),2)
		assert not next(t for t in availability if t.name == tables[0]).bookable
		try:
			api.save_reservation(data)
		except frappe.ValidationError:
			pass
		else:
			raise AssertionError("Overlapping reservation accepted")
		frappe.clear_messages()
		try:
			api.open_table(store.name, tables[0])
		except frappe.ValidationError:
			pass
		else:
			raise AssertionError("Reserved table accepted walk-in")
		frappe.clear_messages()
		first = api.open_table(store.name, tables[0], reservation=booking["name"])
		assert frappe.db.get_value("POS Order", first["name"], "customer") == customer
		assert frappe.db.get_value("Table Reservation", booking["name"], "status") == "Seated"
		assert next(t for t in api.get_floor(store.name) if t.name == tables[0]).occupied
		# New-order customer selection is saved on the actual order. Invalid/disabled
		# customers must not consume the free table or create an empty check.
		selected_customer = ensure(
			"Customer",
			"Floor Selected Guest",
			{
				"customer_name": "Floor Selected Guest",
				"customer_type": "Individual",
				"customer_group": "Individual",
				"territory": "All Territories",
			},
		)
		with self.assertRaises(frappe.DoesNotExistError):
			api.open_table(store.name, tables[4], customer="missing-floor-cycle-customer")
		frappe.clear_messages()
		selected_customer.db_set("disabled", 1)
		with self.assertRaisesRegex(frappe.ValidationError, "disabled"):
			api.open_table(store.name, tables[4], customer=selected_customer.name)
		frappe.clear_messages()
		assert not next(t for t in api.get_floor(store.name) if t.name == tables[4]).occupied
		selected_customer.db_set("disabled", 0)
		chosen = api.open_table(store.name, tables[4], guests=3, customer=selected_customer.name)
		chosen_order = frappe.get_doc("POS Order", chosen["name"])
		assert chosen_order.customer == selected_customer.name and chosen_order.guest_count == 3
		with self.assertRaisesRegex(frappe.ValidationError, "already has an active order"):
			api.open_table(store.name, tables[4], customer=selected_customer.name)
		frappe.clear_messages()
		api.close_empty_table(chosen_order.name)

		def add(name, qty):
			doc = frappe.get_doc("POS Order", name)
			payload = {
				f: doc.get(f)
				for f in [
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
				]
			}
			payload.update(
				{
					"name": name,
					"items": [{"selling_product": product, "qty": qty, "notes": "No sugar", "modifiers": []}],
				}
			)
			return pos.save_order(payload)

		reason = frappe.get_doc(
			dict(
				doctype="POS Action Reason",
				reason="Floor cycle void",
				applies_to="Confirmed Item Cancellation",
				enabled=1,
			)
		).insert(ignore_permissions=True)

		# Confirmation is required for every live row, even after an earlier batch
		# was sent. Removing a saved addition or confirming it unlocks actions again.
		pending_check = api.open_table(store.name, tables[4])
		add(pending_check["name"], 2)
		pos.confirm_order(pending_check["name"])
		add(pending_check["name"], 1)
		assert api.get_table_order(pending_check["name"])["pending_item_count"] == 1
		pending_view = api.get_table_order(pending_check["name"])
		pending_row = next(row for row in pending_view["items"] if not row["sent_to_kitchen"])
		changed = api.update_pending_item(
			pending_check["name"], pending_row["order_item_name"], 3, pending_view["modified"]
		)
		assert next(row for row in changed["items"] if not row["sent_to_kitchen"])["qty"] == 3
		with self.assertRaises(frappe.TimestampMismatchError):
			api.update_pending_item(
				pending_check["name"], pending_row["order_item_name"], 0, pending_view["modified"]
			)
		frappe.clear_messages()
		confirmed_row = next(row for row in changed["items"] if row["sent_to_kitchen"])
		with self.assertRaisesRegex(frappe.ValidationError, "must be voided"):
			api.update_pending_item(
				pending_check["name"], confirmed_row["order_item_name"], 0, changed["modified"]
			)
		frappe.clear_messages()

		invoice_count = frappe.db.count("POS Invoice")
		for action in (
			lambda: api.print_table_check(pending_check["name"]),
			lambda: pos.pay_order(pending_check["name"], [{"mode_of_payment": cash, "amount": 342}]),
			lambda: pos.transfer_order(pending_check["name"], tables[3]),
			lambda: pos.save_guest_check_allocations(pending_check["name"], []),
		):
			with self.assertRaisesRegex(frappe.ValidationError, "Confirm or remove"):
				action()
			frappe.clear_messages()
		assert frappe.db.count("POS Invoice") == invoice_count
		pending_doc = frappe.get_doc("POS Order", pending_check["name"])
		remove = {
			field: pending_doc.get(field)
			for field in (
				"store",
				"restaurant_brand",
				"order_type",
				"customer",
				"dining_area",
				"dining_table",
				"discount_type",
				"discount_scope",
				"discount_value",
				"discount_reason",
			)
		}
		remove.update(name=pending_doc.name, edit_pending_items=True, items=[])
		pos.save_order(remove)
		assert api.get_table_order(pending_doc.name)["pending_item_count"] == 0
		assert "window.print()" in api.print_table_check(pending_doc.name)
		add(pending_doc.name, 1)
		pos.confirm_order(pending_doc.name)
		assert api.get_table_order(pending_doc.name)["pending_item_count"] == 0
		pending_doc = frappe.get_doc("POS Order", pending_doc.name)
		paid = pos.pay_order(pending_doc.name, [{"mode_of_payment": cash, "amount": pending_doc.grand_total}])
		assert paid["status"] == "Paid"

		# Split confirmed quantities to another table: prepared food is redistributed,
		# prices stay fixed, and the earlier void remains audited on the source.
		split_source = api.open_table(store.name, tables[4], guests=4)
		add(split_source["name"], 6)
		draft = frappe.get_doc("POS Order", split_source["name"])
		draft.discount_type, draft.discount_value, draft.discount_reason = (
			"Amount",
			30,
			"Approved table discount",
		)
		draft.save(ignore_permissions=True)
		pos.confirm_order(split_source["name"])
		split_doc = frappe.get_doc("POS Order", split_source["name"])
		ticket = frappe.get_doc(
			"Kitchen Ticket", frappe.db.get_value("Kitchen Ticket", {"pos_order": split_doc.name}, "name")
		)
		ticket.set_status("Started")
		started_at = ticket.started_at
		pos.cancel_confirmed_order_item(split_doc.name, split_doc.items[0].name, 1, reason.name)
		with self.assertRaisesRegex(frappe.ValidationError, "Use Void"):
			pos.cancel_order(split_doc.name)
		frappe.clear_messages()
		split_doc.reload()
		original_total = split_doc.grand_total
		# Changing the catalog must never reprice a confirmed split.
		frappe.db.set_value("Selling Product", product, "selling_price", 900)
		bad_splits = (
			(tables[0], {split_doc.items[0].name: 2}),
			(tables[3], {split_doc.items[0].name: 5}),
			(tables[3], {split_doc.items[0].name: 1.5}),
			(tables[3], {"foreign-row": 1}),
		)
		for destination, selected in bad_splits:
			with self.assertRaises(frappe.ValidationError):
				api.split_table_order(split_doc.name, destination, selected, 1, str(split_doc.modified))
			frappe.clear_messages()
		result = api.split_table_order(
			split_doc.name, tables[3], {split_doc.items[0].name: 2}, 1, str(split_doc.modified)
		)
		split_doc.reload()
		split_new = frappe.get_doc("POS Order", result["name"])
		assert split_doc.items[0].qty == 4 and split_doc.items[0].cancelled_qty == 1
		assert split_new.items[0].qty == 2 and not split_new.items[0].cancelled_qty
		assert split_new.items[0].selling_price == 100 and split_new.items[0].sent_to_kitchen
		assert split_doc.guest_count == 3 and split_new.guest_count == 1
		assert abs(split_doc.grand_total + split_new.grand_total - original_total) < 0.01
		assert len(split_doc.item_cancellations) == 1 and not split_new.item_cancellations
		assert split_doc.status == split_new.status == "In Preparation"
		kitchen_qty = 0
		for check in (split_doc, split_new):
			for ticket_name in frappe.get_all(
				"Kitchen Ticket", filters={"pos_order": check.name}, pluck="name"
			):
				t = frappe.get_doc("Kitchen Ticket", ticket_name)
				t.validate_items()
				assert t.status == "Started" and t.started_at == started_at
				kitchen_qty += sum(row.qty for row in t.items)
		assert kitchen_qty == 6
		# A later pending preparation line separates from an already-started
		# kitchen ticket, keeping its own Pending state and its confirmed price.
		add(split_doc.name, 1)
		pos.confirm_order(split_doc.name)
		split_doc.reload()
		later = next(row for row in split_doc.items if not row.cancelled_qty)
		before_count = frappe.db.count("Kitchen Ticket")
		other = api.split_table_order(split_doc.name, tables[1], {later.name: 1}, 1, str(split_doc.modified))
		assert frappe.db.count("Kitchen Ticket") == before_count + 1
		other_doc = frappe.get_doc("POS Order", other["name"])
		assert other_doc.status == "Confirmed", other_doc.status
		assert other_doc.items[0].selling_price == later.selling_price
		other_ticket = frappe.get_doc(
			"Kitchen Ticket", frappe.db.get_value("Kitchen Ticket", {"pos_order": other_doc.name}, "name")
		)
		other_ticket.validate_items()
		assert other_ticket.status == "Pending"
		pos.cancel_confirmed_order_item(other_doc.name, other_doc.items[0].name, 1, reason.name)
		split_doc.reload()

		# Both split checks can use the normal authorized void mechanism.
		for check in (split_doc, split_new):
			pos.cancel_confirmed_order_item(
				check.name,
				check.items[0].name,
				check.items[0].qty - check.items[0].cancelled_qty,
				reason.name,
			)
		frappe.db.set_value("Selling Product", product, "selling_price", 100)
		frappe.clear_document_cache("Selling Product", product)

		add(first["name"], 2)
		pos.confirm_order(first["name"])
		tickets = frappe.get_all("Kitchen Ticket", filters={"pos_order": first["name"]}, pluck="name")
		assert len(tickets) == 1
		html = api.print_table_check(first["name"])
		assert "window.print()" in html
		assert frappe.db.get_value("POS Order", first["name"], "bill_requested_at")
		second = api.open_table(store.name, tables[1], guests=2)
		add(second["name"], 2)
		pos.confirm_order(second["name"])
		source = frappe.get_doc("POS Order", second["name"])
		pos.cancel_confirmed_order_item(source.name, source.items[0].name, 1, reason.name)
		before = frappe.db.count("Kitchen Ticket")
		assert second["name"] in {row.name for row in api.get_merge_candidates(first["name"])}
		api.merge_table_orders(first["name"], second["name"])
		assert frappe.db.count("Kitchen Ticket") == before
		assert frappe.db.get_value("POS Order", second["name"], "merged_into") == first["name"]
		assert frappe.db.get_value("POS Order", second["name"], "status") == "Cancelled"
		doc = frappe.get_doc("POS Order", first["name"])
		assert len(doc.items) == 2 and all(r.sent_to_kitchen for r in doc.items)
		assert sum(r.amount for r in doc.items) == 300
		assert doc.subtotal == 300
		assert not doc.bill_requested_at
		assert doc.items[1].cancelled_qty == 1
		assert doc.item_cancellations[0].merged_from
		from types import SimpleNamespace
		from rms.analytics.operations import cancellations

		params = {
			"company": C,
			"stores": (store.name,),
			"start": add_to_date(now_datetime(), hours=-1),
			"end": add_to_date(now_datetime(), hours=1),
		}
		ctx = SimpleNamespace(
			query=lambda query: frappe.db.sql(query, params, as_dict=True), accepts=lambda row: True
		)
		_, voids = cancellations(ctx)
		merged_voids = [row for row in voids if row["order_name"] == second["name"]]
		assert len(merged_voids) == 1 and merged_voids[0]["cancelled_value"] == 100
		for ticket_name in frappe.get_all("Kitchen Ticket", filters={"pos_order": doc.name}, pluck="name"):
			ticket = frappe.get_doc("Kitchen Ticket", ticket_name)
			ticket.validate_items()
		pos.transfer_order(doc.name, tables[2])
		assert frappe.db.get_value("POS Order", doc.name, "dining_table") == tables[2]
		assert frappe.db.get_value("Table Reservation", booking["name"], "dining_table") == tables[2]
		doc = frappe.get_doc("POS Order", doc.name)
		pos.save_guest_check_allocations(
			doc.name,
			[
				{"guest_name": "One", "items": [{"name": doc.items[0].name, "qty": 2}]},
				{"guest_name": "Two", "items": [{"name": doc.items[1].name, "qty": 1}]},
			],
		)
		overview = api.get_table_order(doc.name)
		assert len(overview["guest_checks"]) == 2
		for index, check in enumerate(overview["guest_checks"]):
			pos.pay_order(
				doc.name,
				[{"mode_of_payment": cash, "amount": check["payable_total"] - (150 if index == 0 else 0)}],
				guest_check_name=check["name"], deposit_amount=150 if index == 0 else 0,
			)
			if index == 0:
				partial = api.get_table_order(doc.name)
				assert partial["paid_total"] == check["payable_total"]
				assert partial["outstanding_total"] > 0
				receipt = api.print_table_check(doc.name)
				assert "Remaining" in receipt and "Paid" in receipt
		assert frappe.db.get_value("POS Order", doc.name, "status") == "Paid"
		assert frappe.db.get_value("Table Reservation", booking["name"], "status") == "Completed"
		assert not next(t for t in api.get_floor(store.name) if t.name == tables[2]).occupied
		third = api.open_table(store.name, tables[3])
		api.close_empty_table(third["name"])
		assert frappe.db.get_value("POS Order", third["name"], "status") == "Cancelled"

		# Deposits survive cancellation until explicitly refunded, never disappear.
		data.update(dining_table=tables[3], starts_at=str(add_to_date(now_datetime(), hours=1)), ends_at=str(add_to_date(now_datetime(), hours=3)))
		cancelled = api.save_reservation(data)
		received = transact(cancelled["name"], "Receive", 300, cash, "cycle-cancel-receipt")
		assert transact(cancelled["name"], "Receive", 300, cash, "cycle-cancel-receipt")["name"] == received["name"]
		api.set_reservation_status(cancelled["name"], "Cancelled", str(frappe.db.get_value("Table Reservation", cancelled["name"], "modified")))
		assert payment_summary(cancelled["name"])["balance"] == 300
		with self.assertRaisesRegex(frappe.ValidationError,"exceeds"):
			transact(cancelled["name"], "Refund", 301, cash, "cycle-invalid-refund", "Cancelled")
		frappe.clear_messages()
		transact(cancelled["name"], "Refund", 100, cash, "cycle-valid-refund", "Guest cancellation")
		assert payment_summary(cancelled["name"])["balance"] == 200
		assert payment_summary(booking["name"])["balance"] == 0
		assert payment_summary(booking["name"])["applied"] == 150
		session = pos.get_user_session(store.name)
		session.update_expected_amounts()
		# Two paid orders total 342 each; an unused deposit remains a liability.
		assert next(r for r in session.payments if r.mode_of_payment == cash).expected_amount == 884
		for row in frappe.get_all("Reservation Payment", filters={"kind":["in",["Receive","Refund"]]}, fields=["journal_entry"]):
			assert frappe.db.get_value("Journal Entry",row.journal_entry,"docstatus") == 1

		# A deposit can cover the whole bill; its excess is not cash change.
		data.update(dining_table=tables[3], starts_at=str(now_datetime()), ends_at=str(add_to_date(now_datetime(),hours=2)))
		covered = api.save_reservation(data)
		transact(covered["name"], "Receive", 500, cash, "cycle-fully-covered")
		covered_order = api.open_table(store.name,tables[3],reservation=covered["name"])
		add(covered_order["name"],1)
		pos.confirm_order(covered_order["name"])
		paid = pos.pay_order(covered_order["name"], [], deposit_amount=114)
		assert paid["change_amount"] == 0
		assert payment_summary(covered["name"])["balance"] == 386
		transact(covered["name"], "Refund", 386, cash, "cycle-covered-refund", "Unused deposit returned")
		session.reload(); session.update_expected_amounts()
		assert next(r for r in session.payments if r.mode_of_payment == cash).expected_amount == 998
		# The actual ERPNext consolidation must debit the deposit liability and
		# leave only the unused cancelled booking's 200 as a liability.
		invoices = frappe.get_all("POS Invoice", filters={"pos_profile":profile,"docstatus":1}, pluck="name")
		assert any(any(p.mode_of_payment == DEPOSIT_METHOD and p.amount == 150 for p in frappe.get_doc("POS Invoice", name).payments) for name in invoices)
		merge = frappe.get_doc({"doctype":"POS Invoice Merge Log","company":C,"customer":customer,"posting_date":str(now_datetime().date()),
			"pos_invoices":[{"pos_invoice":name,"customer":customer} for name in invoices]}).insert(ignore_permissions=True)
		merge.submit()
		assert frappe.db.get_value("Sales Invoice",merge.consolidated_invoice,"docstatus") == 1
		liability = frappe.db.get_value("Mode of Payment Account",{"parent":DEPOSIT_METHOD,"company":C},"default_account")
		balance = frappe.db.sql("select sum(credit-debit) from `tabGL Entry` where company=%s and account=%s and is_cancelled=0",(C,liability))[0][0]
		assert round(balance,2) == 200, balance
		assert frappe.db.get_value("Sales Invoice",merge.consolidated_invoice,"outstanding_amount") == 0

		# Arrival is allowed more than 30 minutes early, with the planned booking
		# time preserved. The actual seated interval must block another booking.
		arrival_start = add_to_date(now_datetime(),hours=1)
		arrival_end = add_to_date(now_datetime(),hours=3)
		data.update(dining_table=tables[4],starts_at=str(arrival_start),ends_at=str(arrival_end))
		early = api.save_reservation(data)
		assert next(t for t in api.get_arrival_tables(early["name"]) if t.name==tables[4]).bookable
		early_order = api.open_table(store.name,tables[4],reservation=early["name"])
		assert frappe.db.get_value("Table Reservation",early["name"],"starts_at") == arrival_start
		assert frappe.db.get_value("POS Order",early_order["name"],"expected_departure") == arrival_end
		between_start,between_end = add_to_date(now_datetime(),minutes=10),add_to_date(now_datetime(),minutes=40)
		assert not next(t for t in api.get_reservation_tables(store.name,str(between_start),str(between_end),2) if t.name==tables[4]).bookable
		with self.assertRaisesRegex(frappe.ValidationError,"already has a reservation"):
			api.save_reservation({**data,"starts_at":str(between_start),"ends_at":str(between_end)})
		frappe.clear_messages();api.close_empty_table(early_order["name"])

		# A walk-in one hour before a booking needs a bounded stay. Overlapping
		# stays and missing commitments are rejected without consuming the booking.
		data.update(dining_table=tables[0],starts_at=str(arrival_start),ends_at=str(arrival_end))
		later = api.save_reservation(data)
		with self.assertRaisesRegex(frappe.ValidationError,"upcoming reservation"):
			api.open_table(store.name,tables[0])
		frappe.clear_messages()
		with self.assertRaisesRegex(frappe.ValidationError,"overlaps"):
			api.open_table(store.name,tables[0],expected_departure=str(add_to_date(arrival_start,minutes=15)))
		frappe.clear_messages()
		walkin=api.open_table(store.name,tables[0],expected_departure=str(arrival_start))
		with self.assertRaisesRegex(frappe.ValidationError,"expected to stay"):
			api.save_reservation({**data,"starts_at":str(add_to_date(now_datetime(),minutes=15)),"ends_at":str(add_to_date(now_datetime(),minutes=45))})
		frappe.clear_messages()
		assert frappe.db.get_value("Table Reservation",later["name"],"status")=="Reserved"
		assert not frappe.db.get_value("POS Order",walkin["name"],"table_reservation")
		# Reaching the agreed time never closes a real order or seats somebody else.
		from unittest.mock import patch
		from rms.table_service import assert_reservation_available
		with patch("rms.table_service.now_datetime",return_value=add_to_date(arrival_start,minutes=5)),patch("rms.api.table_service.now_datetime",return_value=add_to_date(arrival_start,minutes=5)):
			assert_reservation_available(tables[0],order_name=walkin["name"],expected_departure=str(arrival_start))
			busy=next(t for t in api.get_floor(store.name) if t.name==tables[0])
			assert busy.occupied and busy.open_orders[0]["departure_overdue"]
		assert frappe.db.get_value("POS Order",walkin["name"],"status")=="Open"
		arrival_tables=api.get_arrival_tables(later["name"])
		assert not next(t for t in arrival_tables if t.name==tables[0]).bookable
		assert next(t for t in arrival_tables if t.name==tables[1]).bookable
		with self.assertRaisesRegex(frappe.ValidationError,"active order"):
			api.open_table(store.name,tables[0],reservation=later["name"])
		frappe.clear_messages()
		alternative=api.open_table(store.name,tables[1],reservation=later["name"])
		assert frappe.db.get_value("Table Reservation",later["name"],"dining_table")==tables[1]
		api.close_empty_table(walkin["name"]);api.close_empty_table(alternative["name"])
