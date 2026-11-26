import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import frappe
from frappe.utils import now_datetime, add_to_date

from rms.api import table_service as api
from rms.table_service import validate_reservation_values, validate_merge_snapshot


class TestTableService(unittest.TestCase):
	def test_floor_shows_future_bookings_immediately_and_keeps_busy_precedence(self):
		now = now_datetime()
		bookings = [frappe._dict(name=f"B{i}", dining_table=table, starts_at=add_to_date(now, hours=offset),
			ends_at=add_to_date(now, hours=offset + 2), guests=2)
			for i, (table, offset) in enumerate((("FUTURE", 1), ("TOMORROW", 24), ("CURRENT", -1), ("BUSY", 1)))]
		tables = [frappe._dict(name=name, occupied=name == "BUSY", open_orders=[])
			for name in ("FUTURE", "TOMORROW", "CURRENT", "BUSY", "FREE")]
		with patch("rms.api.pos.get_tables", return_value=tables), patch("rms.api.table_service.current_reservations", return_value=bookings):
			floor = {table.name: table for table in api.get_floor("STORE-1")}
		for name in ("FUTURE", "TOMORROW", "CURRENT"):
			self.assertEqual(floor[name].service_status, "reserved")
		self.assertFalse(floor["FUTURE"].reserved, "a future booking is visible without blocking the present time")
		self.assertTrue(floor["CURRENT"].reserved)
		self.assertEqual(floor["BUSY"].service_status, "occupied")
		self.assertTrue(floor["BUSY"].has_upcoming_reservation)
		self.assertEqual(floor["FREE"].service_status, "available")

	def booking(self, **changes):
		doc = frappe._dict(
			store="STORE-1",
			dining_table="T1",
			guest_name="Guest",
			phone="01000000000",
			guests=2,
			starts_at=now_datetime(),
			ends_at=add_to_date(now_datetime(), hours=2),
			notes="",
			status="Reserved",
		)
		doc.update(changes)
		return doc

	def test_reservation_requires_contact_positive_whole_party_and_forward_interval(self):
		table = frappe._dict(store="STORE-1", enabled=1, capacity=4)
		bad = (
			{"guest_name": " "},
			{"phone": ""},
			{"guests": 0},
			{"guests": 5},
			{"guests": 1.5},
			{"ends_at": add_to_date(now_datetime(), hours=-1)},
			{"notes": "x" * 2001},
		)
		with patch("rms.table_service.frappe.db.get_value", return_value=table):
			for values in bad:
				with self.subTest(values=list(values)), self.assertRaises(frappe.ValidationError):
					validate_reservation_values(self.booking(**values))
			validate_reservation_values(self.booking())

	def test_reservation_cannot_point_at_another_store_or_disabled_table(self):
		for values in ({"store": "OTHER", "enabled": 1}, {"store": "STORE-1", "enabled": 0}):
			with (
				patch("rms.table_service.frappe.db.get_value", return_value=frappe._dict(values)),
				self.assertRaises(frappe.ValidationError),
			):
				validate_reservation_values(self.booking())

	def test_current_reservation_locks_table_and_rejects_overlap(self):
		doc = frappe.get_doc({"doctype": "Table Reservation", **self.booking()})
		with (
			patch("rms.table_service.validate_reservation_values"),
			patch("rms.table_service.lock_tables") as lock,
			patch("rms.api.pos.require_pos_action"),
			patch("rms.api.pos.assert_store_access"),
			patch("rms.streaming_replica.upstream", return_value=False),
			patch("rms.table_service.conflicting_reservations", return_value=[frappe._dict(name="EXISTING")]) as exists,
		):
			with self.assertRaisesRegex(frappe.ValidationError, "already has a reservation"):
				doc.validate()
			lock.assert_called_once()
			exists.assert_called_once_with(doc.dining_table,doc.starts_at,doc.ends_at,doc.name,lock=True)

	def test_availability_uses_current_reads_after_waiting_for_a_table_lock(self):
		from rms.table_service import current_exists

		with patch("frappe.db.get_value", return_value="RESERVATION") as read:
			self.assertTrue(current_exists("Table Reservation", {"dining_table": "T1"}))
		read.assert_called_once_with("Table Reservation", {"dining_table": "T1"}, "name", for_update=True)

	def test_stale_or_missing_reservation_revision_is_rejected(self):
		doc = SimpleNamespace(modified="2026-11-17 12:00:00")
		for value in (None, "2026-11-17 11:59:59"):
			with self.assertRaises(frappe.TimestampMismatchError):
				api.check_modified(doc, value)
		api.check_modified(doc, doc.modified)

	def test_remote_store_is_denied_before_loading_reservations(self):
		with (
			patch("rms.api.pos.require_pos_action"),
			patch("rms.api.pos.assert_store_access", side_effect=frappe.PermissionError),
			patch("frappe.get_all") as read,
		):
			with self.assertRaises(frappe.PermissionError):
				api.get_reservations("REMOTE")
			read.assert_not_called()

	def test_open_table_requires_own_open_till_before_creating_order(self):
		for session in (
			None,
			SimpleNamespace(status="Closed", user=frappe.session.user),
			SimpleNamespace(status="Open", user="other@example.com"),
		):
			with (
				patch("rms.api.pos.require_pos_action"),
				patch("rms.api.pos.assert_store_access"),
				patch("rms.api.pos.get_user_session", return_value=session),
				patch("frappe.get_doc") as create,
			):
				with self.assertRaises(frappe.ValidationError):
					api.open_table("STORE-1", "T1")
				create.assert_not_called()

	def test_no_show_cannot_be_marked_before_arrival_time(self):
		doc = frappe._dict(
			name="RES1",
			store="STORE-1",
			status="Reserved",
			starts_at=add_to_date(now_datetime(), days=1),
			modified="2026-11-17 12:00:00",
		)
		doc.save = Mock()
		with (
			patch("rms.api.pos.require_pos_action"),
			patch("rms.api.pos.assert_store_access"),
			patch("frappe.get_doc", return_value=doc),
		):
			with self.assertRaisesRegex(frappe.ValidationError, "after the reservation"):
				api.set_reservation_status(doc.name, "No Show", doc.modified)
		doc.save.assert_not_called()

	def test_close_table_cannot_cancel_a_populated_bill(self):
		for field in ("items", "payments", "guest_checks"):
			doc = frappe._dict(items=[], payments=[], guest_checks=[])
			doc[field] = [frappe._dict(name="ROW")]
			with (
				patch("rms.api.pos.require_pos_action"),
				patch("rms.api.pos.get_owned_order", return_value=doc),
				patch("rms.api.pos.cancel_order") as cancel,
			):
				with self.assertRaises(frappe.ValidationError):
					api.close_empty_table("ORDER")
				cancel.assert_not_called()

	def test_merge_protects_paid_allocated_and_other_cashier_checks(self):
		for extra in (
			{"payments": [1]},
			{"guest_checks": [1]},
			{"pos_invoice": "INV"},
			{"cashier_session": "OTHER"},
			{"status": "Paid"},
		):
			orders = []
			for name in ("A", "B"):
				orders.append(
					frappe._dict(
						name=name,
						store="STORE-1",
						status="Confirmed",
						cashier_session="SESSION",
						payments=[],
						guest_checks=[],
						pos_invoice=None,
					)
				)
			orders[1].update(extra)
			with (
				patch("rms.api.pos.require_pos_action"),
				patch("rms.api.pos.assert_store_access"),
				patch("rms.api.pos.require_order_scope"),
				patch(
					"rms.api.pos.get_user_session", return_value=frappe._dict(name="SESSION", status="Open")
				),
				patch("frappe.get_doc", side_effect=orders),
				patch("rms.api.table_service.lock_tables") as mutate,
			):
				with self.assertRaises((frappe.ValidationError, frappe.PermissionError)):
					api.merge_table_orders("A", "B")
				mutate.assert_not_called()

	def test_browser_flags_do_not_authorize_saved_snapshot_mutations(self):
		doc = frappe.get_doc(
			{"doctype": "POS Order", "flags": {"allow_merge": True, "allow_table_merge": True}}
		)
		self.assertFalse(validate_merge_snapshot(doc))

	def test_failed_print_authorization_does_not_mark_bill_requested(self):
		doc = Mock()
		with (
			patch("frappe.get_doc", return_value=doc),
			patch("rms.api.pos.get_open_order_check_print_html", side_effect=frappe.PermissionError),
		):
			with self.assertRaises(frappe.PermissionError):
				api.print_table_check("ORDER")
		doc.save.assert_not_called()


class TestTableItemSnapshots(unittest.TestCase):
	def test_kitchen_state_comes_from_moved_lines_in_a_mixed_ticket(self):
		pending = frappe._dict(qty=1, status="Pending")
		started = frappe._dict(qty=2, status="Started")
		self.assertEqual(api.kitchen_status_for_items([pending]), "Pending")
		self.assertEqual(api.kitchen_status_for_items([started]), "Started")
		self.assertEqual(api.kitchen_status_for_items([started, pending]), "Started")
		self.assertEqual(
			api.kitchen_status_for_items([dict(qty=1, status="Ready"), dict(qty=1, status="Picked")]), "Ready"
		)

	def test_split_scales_total_recipe_quantities_but_preserves_unit_prices_and_modifiers(self):
		import copy
		from rms.snapshots import parse_json_rows

		original = frappe._dict(
			qty=6,
			cancelled_qty=1,
			selling_price=100,
			recipe_snapshot='[{"item":"INGREDIENT","qty":12,"warehouse":"KITCHEN"}]',
			modifiers='[{"qty":1,"selling_price":5}]',
		)
		source, destination = copy.deepcopy(original), copy.deepcopy(original)
		destination.cancelled_qty = 0
		api.resize_item_snapshot(source, 4)
		api.resize_item_snapshot(destination, 2)
		self.assertEqual(source.amount + destination.amount, 525)
		self.assertEqual(source.selling_price, destination.selling_price)
		self.assertEqual(source.modifiers, original.modifiers)
		self.assertEqual(parse_json_rows(source.recipe_snapshot)[0].qty, 8)
		self.assertEqual(parse_json_rows(destination.recipe_snapshot)[0].qty, 4)
		self.assertEqual(source.cancelled_qty, 1)


class TestPendingFloorItems(unittest.TestCase):
	def test_invalid_or_stale_edits_cannot_remove_or_change_a_saved_row(self):
		doc = frappe.get_doc(
			dict(
				doctype="POS Order",
				name="ORDER",
				status="Confirmed",
				dining_table="T1",
				modified="2026-11-17 12:00:00",
				items=[dict(name="PENDING", qty=2, uom="Nos", sent_to_kitchen=0)],
			)
		)
		with (
			patch("rms.api.pos.require_pos_action"),
			patch("rms.api.pos.get_owned_order", return_value=doc),
			patch("frappe.get_cached_value", return_value=1),
			patch("rms.api.pos.save_order") as save,
		):
			for qty in (None, "invalid", float("nan"), float("inf"), -1, 1.5):
				with self.subTest(qty=str(qty)), self.assertRaises(frappe.ValidationError):
					api.update_pending_item(doc.name, "PENDING", qty, str(doc.modified))
			with self.assertRaises(frappe.TimestampMismatchError):
				api.update_pending_item(doc.name, "PENDING", 0, "2026-11-17 11:59:59")
			save.assert_not_called()
			self.assertEqual(doc.items[0].qty, 2)
