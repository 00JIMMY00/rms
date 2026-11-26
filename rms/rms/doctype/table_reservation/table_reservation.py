from datetime import timedelta
import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import get_datetime, now_datetime


class TableReservation(Document):
	def validate(self):
		from rms.api.pos import assert_store_access, require_pos_action
		from rms.table_service import lock_tables, validate_reservation_values, current_exists, conflicting_reservations, visit_overlaps
		from rms.streaming_replica import upstream

		validate_reservation_values(self)
		if upstream(self):
			if self.pos_order and frappe.db.get_value("POS Order", self.pos_order, "store") != self.store:
				frappe.throw(_("The reservation must be linked to its table order."))
			return
		require_pos_action("can_view_tables")
		assert_store_access(self.store)
		previous = self.get_doc_before_save()
		if previous:
			if previous.store != self.store or (
				previous.status != "Reserved"
				and any(
					self.get(key) != previous.get(key)
					for key in ("starts_at", "ends_at", "guest_name", "phone", "guests")
				)
			):
				frappe.throw(_("Only an upcoming reservation can be changed."))
			allowed = {
				"Reserved": {"Reserved", "Seated", "Cancelled", "No Show"},
				"Seated": {"Seated", "Completed", "Cancelled"},
			}
			if self.status not in allowed.get(previous.status, {previous.status}):
				frappe.throw(_("This reservation status change is not allowed."))
		elif self.status != "Reserved":
			frappe.throw(_("A new reservation must start Reserved."))
		lock_tables([self.dining_table, previous.dining_table if previous else None])
		if self.status == "Reserved":
			if (not previous or get_datetime(previous.starts_at) != get_datetime(self.starts_at)) and get_datetime(self.starts_at) < now_datetime() - timedelta(minutes=5):
				frappe.throw(_("Choose a future reservation time."))
			if (get_datetime(self.ends_at) - get_datetime(self.starts_at)).total_seconds() > 12 * 3600:
				frappe.throw(_("A reservation cannot exceed 12 hours."))
			if get_datetime(self.ends_at) <= now_datetime():
				frappe.throw(_("Choose a reservation that ends in the future."))
			overlaps = conflicting_reservations(self.dining_table, self.starts_at, self.ends_at, self.name, lock=True)
			if overlaps:
				frappe.throw(_("This table already has a reservation during the selected time."))
			if visit_overlaps(self.dining_table, self.starts_at, self.ends_at, lock=True):
				frappe.throw(_("This table has guests expected to stay into that time. Choose a later time or another table."))
			if get_datetime(self.starts_at) <= now_datetime() and current_exists(
				"POS Order",
				{
					"dining_table": self.dining_table,
					"status": ["not in", ["Paid", "Cancelled"]],
				},
			):
				frappe.throw(_("This table is busy now. Choose a future reservation time."))
		if self.status in ("Seated", "Completed"):
			order = (
				frappe.db.get_value(
					"POS Order", self.pos_order, ["store", "dining_table", "status"], as_dict=True
				)
				if self.pos_order
				else None
			)
			if (
				not order
				or order.store != self.store
				or (self.status == "Seated" and order.dining_table != self.dining_table)
			):
				frappe.throw(_("The reservation must be linked to its table order."))
			if self.status == "Completed" and order.status != "Paid":
				frappe.throw(_("Complete payment before completing the reservation."))
		if previous and previous.status == "Seated" and self.status == "Cancelled":
			if frappe.db.get_value("POS Order", self.pos_order, "status") != "Cancelled":
				frappe.throw(_("Close the table order before cancelling this reservation."))

	def on_trash(self):
		frappe.throw(_("Cancel reservations instead of deleting their history."))
