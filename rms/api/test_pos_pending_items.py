"""Pending additions stay editable after autosave on a confirmed order."""
import copy
import json
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import frappe

from rms.api.pos import save_order
from rms.api import pos, table_service


class TestPendingOrderItems(unittest.TestCase):
	def order(self):
		doc = frappe.new_doc("POS Order")
		doc.update(dict(name="ORDER-1", store="STORE-1", cashier_session="SESSION-1", status="Confirmed",
			restaurant_brand="BRAND-1", order_type="Takeaway"))
		for name, sent in (("SENT-1", 1), ("PENDING-1", 0)):
			doc.append("items", dict(name=name, selling_product="TEA", qty=1, selling_price=10,
				amount=10, sent_to_kitchen=sent, modifiers="[]", recipe_snapshot="[]"))
		return doc

	def test_pending_quantity_and_removal_do_not_unlock_confirmed_rows(self):
		previous = self.order()
		current = copy.deepcopy(previous)
		current.items[1].qty = 4
		current.validate_pending_item_edit(previous)
		current.set("items", [current.items[0]])
		current.validate_pending_item_edit(previous)
		current.items[0].qty = 2
		with self.assertRaisesRegex(frappe.ValidationError, "Confirmed items cannot"):
			current.validate_pending_item_edit(previous)

	def test_sent_identity_and_confirmation_flag_are_protected(self):
		previous = self.order()
		for mutate in (lambda doc: setattr(doc.items[0], "name", "REPLACEMENT"),
			lambda doc: setattr(doc.items[0], "sent_to_kitchen", 0),
			lambda doc: setattr(doc.items[1], "sent_to_kitchen", 1)):
			current = copy.deepcopy(previous)
			mutate(current)
			with self.assertRaisesRegex(frappe.ValidationError, "Confirmed items cannot"):
				current.validate_pending_item_edit(previous)

	def test_guest_allocations_cannot_be_edited(self):
		previous = self.order()
		previous.append("guest_checks", {"name": "CHECK-1", "status": "Open"})
		with self.assertRaises(frappe.ValidationError):
			copy.deepcopy(previous).validate_pending_item_edit(previous)

	def save(self, doc, items, order_type=None):
		data = {field: doc.get(field) for field in ("store", "restaurant_brand", "order_type", "customer",
			"external_reference", "dining_area", "dining_table", "discount_type", "discount_scope", "discount_value", "discount_reason")}
		data.update(name=doc.name, edit_pending_items=True, items=items)
		if order_type:
			data["order_type"] = order_type
		session = frappe._dict(name="SESSION-1", status="Open", user=frappe.session.user)
		with ExitStack() as stack:
			for name, value in {"require_pos_action": None, "require_order_scope": None,
				"assert_store_access": frappe._dict(name=doc.store), "get_user_session": session,
				"get_brands": [{"name": doc.restaurant_brand}], "get_order_types": [{"name": doc.order_type}],
				"frappe.get_doc": doc}.items():
				stack.enter_context(patch("rms.api.pos." + name, return_value=value))
			stack.enter_context(patch.object(doc, "is_new", return_value=False))
			stack.enter_context(patch.object(doc, "save"))
			return save_order(json.dumps(data))

	def test_api_reuses_pending_identity_and_accepts_empty_pending_list(self):
		doc = self.order()
		result = self.save(doc, [{"order_item_name": "PENDING-1", "selling_product": "TEA", "qty": 3}])
		self.assertEqual([(row.name, row.qty) for row in doc.items], [("SENT-1", 1), ("PENDING-1", 3)])
		self.assertEqual(result["appended_items"][0]["name"], "PENDING-1")
		self.save(doc, [])
		self.assertEqual([row.name for row in doc.items], ["SENT-1"])

	def test_unconfirmed_orders_cannot_change_type_or_lose_their_rows(self):
		for status in ("Open", "Pending Confirmation"):
			doc = self.order()
			doc.status = status
			for row in doc.items:
				row.sent_to_kitchen = 0
			with self.assertRaisesRegex(frappe.ValidationError, "Start a new order"):
				self.save(doc, [], order_type="Dine In")
			self.assertEqual(doc.order_type, "Takeaway")
			self.assertEqual([row.name for row in doc.items], ["SENT-1", "PENDING-1"])

	def test_api_rejects_sent_and_foreign_row_ids(self):
		for name in ("SENT-1", "ANOTHER-ORDER-ITEM"):
			with self.assertRaisesRegex(frappe.ValidationError, "Only unconfirmed items"):
				self.save(self.order(), [{"order_item_name": name, "selling_product": "TEA", "qty": 3}])

	def test_order_actions_unlock_only_after_confirmation_or_removal(self):
		doc = self.order()
		self.assertTrue(pos.has_unconfirmed_items(doc))
		with self.assertRaisesRegex(frappe.ValidationError, "Confirm or remove"):
			pos.assert_items_confirmed(doc)
		doc.items[1].sent_to_kitchen = 1
		pos.assert_items_confirmed(doc)
		doc.items[1].sent_to_kitchen = 0
		doc.set("items", [doc.items[0]])
		pos.assert_items_confirmed(doc)
		for values in (dict(qty=0), dict(qty=2, cancelled_qty=2)):
			doc.append("items", dict(selling_product="TEA", sent_to_kitchen=0, **values))
		pos.assert_items_confirmed(doc)
		self.assertTrue(pos.has_unconfirmed_items({"items": [{"qty": 1, "sent_to_kitchen": "0"}]}))

	def test_unconfirmed_additions_block_every_financial_and_table_action_before_writes(self):
		for name, invoke in (
			("payment", lambda: pos.pay_order("ORDER-1", [])),
			("check print", lambda: pos.get_open_order_check_print_html("ORDER-1")),
			("receipt print", lambda: pos.get_pos_invoice_print_html("ORDER-1")),
			("floor print", lambda: table_service.print_table_check("ORDER-1")),
			("transfer", lambda: pos.transfer_order("ORDER-1", "TABLE-2")),
			("legacy merge", lambda: pos.merge_orders("ORDER-1", "ORDER-2")),
			("draft split", lambda: pos.split_order("ORDER-1", '{"PENDING-1": 1}')),
			("item split", lambda: pos.save_guest_check_allocations("ORDER-1", [])),
			("guest resplit", lambda: pos.resplit_open_guest_check("ORDER-1", "GUEST", [])),
			("cancel check", lambda: pos.cancel_order("ORDER-1")),
			("void items", lambda: pos.get_order_item_cancellation_options("ORDER-1")),
			("discount", lambda: pos.preview_order_discount("ORDER-1")),
			("table merge", lambda: table_service.merge_table_orders("ORDER-1", "ORDER-2")),
			("merge candidates", lambda: table_service.get_merge_candidates("ORDER-1")),
			("table split", lambda: table_service.split_table_order("ORDER-1", "T2", {}, 1, "2026-11-17 12:00:00")),
		):
			with self.subTest(action=name), ExitStack() as stack:
				doc = self.order()
				for method in ("require_pos_role", "require_pos_action", "assert_store_access", "require_order_scope"):
					stack.enter_context(patch("rms.api.pos." + method))
				stack.enter_context(patch("rms.api.pos.frappe.get_doc", return_value=doc))
				stack.enter_context(patch("rms.api.pos.get_owned_order", return_value=doc))
				stack.enter_context(patch("rms.api.pos.get_owned_draft_order", return_value=doc))
				save = stack.enter_context(patch.object(doc, "save"))
				with self.assertRaisesRegex(frappe.ValidationError, "Confirm or remove"):
					invoke()
				save.assert_not_called()
