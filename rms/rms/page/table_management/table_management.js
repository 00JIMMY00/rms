// Existing bookmarks open the Tables view inside the same POS and cashier session.
frappe.pages["table-management"].on_page_load = () => {};
frappe.pages["table-management"].on_page_show = () => setTimeout(open_tables_in_pos, 0);

function open_tables_in_pos() {
	try {
		const pos = window.rmsPointOfSale;
		const raw = sessionStorage.getItem("rms-tables-launch-context");
		const previous = raw ? JSON.parse(raw) : null;
		sessionStorage.removeItem("rms-tables-launch-context");
		const remembered = sessionStorage.getItem(`rms-tables-store:${frappe.session?.user || ""}`);
		const store = pos?.state.store || previous?.store || remembered || null;
		sessionStorage.setItem("rms-pos-launch-context", JSON.stringify({ store, view: "tables" }));
	} catch (_) { /* The route still opens when browser storage is unavailable. */ }
	frappe.set_route("point-of-sale");
}
