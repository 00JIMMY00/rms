"""Authorization and audit protections for the reservation money workflow."""
import unittest
from unittest.mock import Mock, patch
import frappe
from rms.reservation_payments import transact, writing_payment


class TestReservationPayments(unittest.TestCase):
    def test_posted_browser_flags_cannot_create_or_edit_ledger_entries(self):
        doc = frappe.get_doc({"doctype":"Reservation Payment", "kind":"Receive", "amount":100,
                              "flags":{"from_pos_api":True,"ignore_permissions":True}})
        doc.set("__islocal", 1)
        with patch("rms.streaming_replica.upstream", return_value=False):
            with self.assertRaisesRegex(frappe.ValidationError,"immutable"):
                doc.validate()
            token=writing_payment.set(True)
            try:
                doc.validate()
                doc.name="SAVED"
                doc.is_new=lambda:False
                with self.assertRaisesRegex(frappe.ValidationError,"immutable"):
                    doc.validate()
            finally:writing_payment.reset(token)

    def test_foreign_store_is_rejected_before_reading_payment_history(self):
        booking=frappe._dict(store="FOREIGN")
        with patch("rms.api.pos.require_pos_action"), patch("frappe.get_doc",return_value=booking), \
             patch("rms.api.pos.assert_store_access",side_effect=frappe.PermissionError), patch("frappe.db.get_value") as query:
            with self.assertRaises(frappe.PermissionError):
                transact("BOOKING","Refund",100,"Cash","test-request-123")
            query.assert_not_called()

    def test_cashier_cannot_refund_a_deposit_without_manager_role(self):
        booking=frappe._dict(store="STORE",status="Cancelled")
        session=frappe._dict(name="SHIFT",status="Open",user=frappe.session.user,payments=[frappe._dict(mode_of_payment="Cash")])
        with patch("rms.api.pos.require_pos_action"), patch("rms.api.pos.assert_store_access"), \
             patch("frappe.get_doc",side_effect=[booking,session]), patch("frappe.db.get_value",return_value=None), \
             patch("rms.api.pos.get_user_session",return_value=session),patch("frappe.get_roles",return_value=["POS Cashier"]), \
             patch("rms.reservation_payments.record") as write:
            with self.assertRaisesRegex(frappe.PermissionError,"POS Manager"):
                transact("BOOKING","Refund",100,"Cash","test-request-123", "Cancelled")
            write.assert_not_called()

    def test_a_retry_cannot_reuse_a_receipt_id_for_another_amount(self):
        booking=frappe._dict(store="STORE")
        receipt=frappe._dict(name="RECEIPT",reservation="BOOKING",kind="Receive",amount=100,mode_of_payment="Cash")
        with patch("rms.api.pos.require_pos_action"),patch("rms.api.pos.assert_store_access"), \
             patch("frappe.get_doc",return_value=booking),patch("frappe.db.get_value",return_value=receipt):
            with self.assertRaisesRegex(frappe.ValidationError,"different transaction"):
                transact("BOOKING","Receive",101,"Cash","test-request-123")
