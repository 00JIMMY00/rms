app_name = "rms"
app_title = "RMS"
app_publisher = "RMS Project"
app_description = "Integrated enterprise resource planning"
app_email = ""
app_license = "MIT"
required_apps = ["erpnext"]
app_logo_url = "/assets/rms/images/rms-mark.svg"
app_home = "/rms"

add_to_apps_screen = [
	{
		"name": "rms",
		"logo": "/assets/rms/images/rms-mark.svg",
		"title": "RMS",
		# Desk routes are validated as Workspaces by the app launcher.
		# Use our entry page so Point of Sale (a Page) is not replaced by a workspace.
		"route": "/rms",
		"sequence_id": 10,
	}
]

app_include_js = [
	"/assets/rms/js/rms_management_workspace.js?v=studio-9",
	"/assets/rms/js/rms_desk.js?v=desk-a-90",
	"/assets/rms/js/rms_form_experience.js?v=forms-2",
	"/assets/rms/js/approval_notifications.js?v=4",
]
app_include_css = [
	"/assets/rms/css/rms_desk.css?v=desk-a-15",
	"/assets/rms/css/point_of_sale.css?v=pos-a-101",
	"/assets/rms/css/rms_management_studio.css?v=studio-14",
	"/assets/rms/css/rms_form_experience.css?v=forms-2",
]
update_website_context = "rms.interface_preferences.website_context"

after_migrate = ["rms.setup.ensure_pos_roles", "rms.branding.apply_branding"]
after_install = "rms.branding.apply_branding"

from rms.streaming import doc_events as rms_sync_doc_events

doc_events = {**rms_sync_doc_events, "Sales Invoice": {
	"before_validate": ["rms.pos_rounding.preserve_consolidated_pos_no_rounding", "rms.stock.prevent_duplicate_return_stock"],
}}

extend_doctype_class = {
	"POS Invoice": "rms.pos_rounding.POSInvoiceRoundingMixin",
}

# Frappe 15 does not implement extend_doctype_class. Use its supported override
# mechanism so recalculation during invoice validation retains the same rounding.
import frappe as _frappe

if int(_frappe.__version__.split(".")[0]) < 16:
	override_doctype_class = {"POS Invoice": "rms.pos_invoice.RMSPOSInvoice"}

# Transaction Deletion Record must keep RMS catalog and setup records intact.
company_data_to_be_ignored = [
	"Selling Product",
	"Product Category",
	"Restaurant Brand",
	"Store",
	"Store Menu",
	"Store Brand Assignment",
	"Store Working Hour",
	"Store Order Type Tax",
	"Store User Assignment",
	"Dining Area",
	"Dining Table",
	"Preparation Area",
	"Modifier Group",
	"Order Type",
	"Order Type Account Mapping",
	"POS User",
	"POS User Store",
	"POS User Brand",
	"POS User Preparation Area",
	"POS User Order Type",
	"Expense Category",
	"Print Device",
	"RMS Sync Settings",
]

doctype_js = {
	"Approval Challenge": "public/js/approval_challenge.js",
	"POS User": "public/js/pos_user.js",
	"Selling Product": "public/js/selling_product.js",
	"POS Return": "public/js/pos_return.js",
	"Shift Expense": "public/js/shift_expense.js",
}

permission_query_conditions = {
	"POS Return": "rms.api.pos.get_pos_return_permission_query",
	"Shift Expense": "rms.api.pos.get_shift_expense_permission_query",
	"Approval Challenge": "rms.api.pos.get_approval_challenge_permission_query",
	"Print Dispatch Job": "rms.api.printing.get_print_dispatch_job_permission_query",
}

has_permission = {
	"POS Return": "rms.api.pos.has_pos_return_permission",
	"Shift Expense": "rms.api.pos.has_shift_expense_permission",
	"Approval Challenge": "rms.api.pos.has_approval_challenge_permission",
	"Print Dispatch Job": "rms.api.printing.has_print_dispatch_job_permission",
}

