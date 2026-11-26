import frappe
from frappe import _
from frappe.model.document import Document

class ReservationPayment(Document):
    def validate(self):
        from rms.streaming_replica import upstream, validate as validate_replica
        if upstream(self):
            validate_replica(self)
            return
        from rms.reservation_payments import writing_payment
        if not self.is_new() or not writing_payment.get():
            frappe.throw(_("Reservation payments are immutable and are recorded through the POS workflow."))

    def on_trash(self):
        frappe.throw(_("Reservation payments cannot be deleted. Record a refund instead."))
