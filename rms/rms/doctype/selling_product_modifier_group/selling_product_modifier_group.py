import frappe
from frappe import _
from frappe.model.document import Document


def get_minimum_selections(group_row, group_minimum=0):
	"""Resolve a product override without changing the shared Modifier Group."""
	requirement = group_row.get("selection_requirement") or "Default"
	if requirement == "Optional":
		return 0
	if requirement == "Required":
		return 1
	if requirement == "Default":
		return group_minimum or 0
	frappe.throw(_("Choose Default, Optional or Required for Selection Requirement."))


def get_maximum_selections(group):
	"""Zero means unlimited only for multiple-choice groups."""
	return (group.get("max_selections") or 0) if group.get("allow_multiple_selections") else 1


class SellingProductModifierGroup(Document):
	pass
