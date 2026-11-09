import unittest
from unittest.mock import patch

import frappe

from rms.api.pos import get_product_configuration
from rms.rms.doctype.selling_product.selling_product import SellingProduct
from rms.rms.doctype.selling_product_modifier_group.selling_product_modifier_group import get_minimum_selections, get_maximum_selections


class TestProductModifierRequirement(unittest.TestCase):
	def test_default_and_legacy_rows_inherit_the_group_minimum(self):
		for row in (frappe._dict(), frappe._dict(selection_requirement="Default")):
			for minimum in (0, 1, 2):
				self.assertEqual(get_minimum_selections(row, minimum), minimum)

	def test_optional_overrides_a_required_group(self):
		self.assertEqual(get_minimum_selections(frappe._dict(selection_requirement="Optional"), 1), 0)

	def test_required_overrides_an_optional_group(self):
		self.assertEqual(get_minimum_selections(frappe._dict(selection_requirement="Required"), 0), 1)

	def test_unknown_requirement_is_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			get_minimum_selections(frappe._dict(selection_requirement="Unknown"), 1)

	def test_product_validation_rejects_an_unknown_requirement(self):
		product = frappe._dict(modifier_groups=[frappe._dict(modifier_group="Temperature", selection_requirement="Unknown")], modifier_options=[])
		with self.assertRaises(frappe.ValidationError):
			SellingProduct.validate_modifiers(product)

	def test_pos_configuration_uses_each_products_override(self):
		group = frappe._dict(title="Temperature", enabled=1, min_selections=1,
			allow_multiple_selections=0, allow_collapse=1, collapsed_by_default=0)
		for requirement, expected in (("Optional", 0), ("Required", 1), ("Default", 1)):
			with self.subTest(requirement=requirement):
				product = frappe._dict(name="PRODUCT-1", title="Product", enabled=1, uom="Nos", has_options=0,
					option_products=[], modifier_options=[], modifier_groups=[frappe._dict(modifier_group="Temperature", selection_requirement=requirement, sequence_id=1)],
					resolve_price=lambda *args, **kwargs: {"selling_price": 100})
				with patch("rms.api.pos.require_pos_role"), patch("rms.api.pos.assert_store_access"), \
					patch("rms.api.pos.get_brands", return_value=[{"name": "BRAND-1"}]), \
					patch("rms.api.pos.get_order_types", return_value=[{"name": "Takeaway"}]), \
					patch("rms.api.pos.frappe.get_doc", return_value=product), \
					patch("rms.api.pos.frappe.db.get_value", return_value=group), \
					patch("rms.api.pos.frappe.get_cached_value", return_value=1):
					config = get_product_configuration(product.name, "STORE-1", "BRAND-1", "Takeaway")
				self.assertEqual(config["modifier_groups"][0]["min_selections"], expected)
				self.assertEqual(config["modifier_groups"][0]["max_selections"], 1)

	def test_maximum_is_independent_of_the_product_minimum_override(self):
		for multiple, maximum, expected in [(0,0,1),(1,0,0),(1,2,2)]:
			self.assertEqual(get_maximum_selections(frappe._dict(allow_multiple_selections=multiple,max_selections=maximum)), expected)
