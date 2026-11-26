window.RMSTableManagement = class RMSTableManagement {
	constructor(wrapper, pos) {
		this.pos = pos;
		this.page = { main: $(wrapper) };
		this.page.main.addClass("rms-tables-page rms-tables-embedded");
		wrapper.rmsTables = this;
		const launchStore = pos.state.store;
		this.state = { stores: [], store: launchStore, store_title: null, currency: null, session: null, permissions: {}, areas: [], tables: [],
			area: "all", status: "all", search: "", selected: null, selectedOrder: null, order: null, tab: "order" };
		this.detailRequest = 0;
		this.mount();
		this.bind();
		for (const type of ["click", "change", "input", "keydown"]) wrapper.addEventListener(type, event => event.stopPropagation());
		this.refreshTimer = setInterval(() => {
			if ((frappe.get_route?.() || [])[0] !== "point-of-sale" || this.pos.contentView !== "tables" || document.hidden) return;
			this.renderClock();
			if (!document.querySelector(".modal.show, .modal.in") && !this.loading) this.load(true);
		}, 30000);
	}

	call(method, args = {}) {
		return new Promise((resolve, reject) => frappe.call({ method: method.includes(".") ? method : `rms.api.pos.${method}`, args,
			callback: (response) => resolve(response.message), error: (error) => reject(error) }));
	}

	escape(value) { return frappe.utils.escape_html(String(value ?? "")); }
	currency(value) { return format_currency(value || 0, this.state.currency || undefined); }

	floorLabel(value) {
		const label = String(value || "").trim();
		const prefixes = [this.state.store_title, this.state.store].filter(Boolean)
			.flatMap(store => [store, String(store).split(/\s+[-–—|]\s+/).pop()])
			.sort((a, b) => b.length - a.length);
		for (const prefix of prefixes) {
			if (!label.startsWith(prefix)) continue;
			const rest = label.slice(prefix.length);
			if (/^\s*[-–—:|/]\s*\S/.test(rest)) return rest.replace(/^\s*[-–—:|/]\s*/, "");
		}
		return label;
	}

	tableLabel(table) { return this.floorLabel(table.title || table.name); }
	areaLabel(table) { return this.floorLabel(table.dining_area_title || table.dining_area); }
	isFreeTable(table) { return this.statusOf(table) === "available" && !table.occupied && !table.reserved && !(table.open_orders || []).length; }

	icon(name, className = "") {
		const paths = {
			table: '<rect x="7" y="6" width="10" height="12" rx="4"/><path d="M4 8v8m16-8v8M9 3h6M9 21h6"/>',
			search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
			pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
			clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
			user: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
			seats: '<path d="M6 4v9h12V4M4 10v5h16v-5M6 15v5m12-5v5M8 4h8"/>',
			arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
			close: '<path d="m6 6 12 12M6 18 18 6"/>',
			refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
			plus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8m-4-4v8"/>',
			move: '<path d="M4 12h16m-5-5 5 5-5 5M4 7v10"/>',
			split: '<path d="M12 21v-7c0-3-6-3-6-6V3m12 0v5c0 3-6 3-6 6M3 6l3-3 3 3m6 0 3-3 3 3"/>',
			merge: '<path d="M6 21v-5c0-3 6-3 6-7V3m6 18v-5c0-3-6-3-6-7M9 6l3-3 3 3"/>',
			print: '<path d="M7 8V3h10v5M7 17H4V8h16v9h-3"/><path d="M7 14h10v7H7zM16 11h1"/>',
			check: '<path d="m5 12 4 4L19 6"/>',
			calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
			note: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
		};
		return `<svg class="rms-floor-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.table}</svg>`;
	}

	mount() {
		this.page.main.html(`
			<div class="rms-floor-shell">
				<div class="rms-floor-layout">
					<main class="rms-floor-board">
						<div class="rms-floor-toolbar">
							<h1 class="sr-only">${__("Tables")}</h1>
							<div class="rms-floor-areas" data-role="areas" role="group" aria-label="${__("Dining Area")}"></div>
							<div class="rms-floor-toolbar-actions">
								<details class="rms-floor-status-menu"><summary aria-label="${__("Table status")}" data-floor-status-label></summary><div data-floor-status-options role="group" aria-label="${__("Table status")}"></div></details>
								<button type="button" class="rms-floor-reservations-button" data-action="reservations" title="${__("Reservations")}" aria-label="${__("Reservations")}">${this.icon("calendar")}<span>${__("Reservations")}</span></button>
								<button type="button" class="rms-floor-refresh" data-action="refresh" title="${__("Refresh")}" aria-label="${__("Refresh")}">${this.icon("refresh")}</button>
							</div>
						</div>
						<div class="rms-floor-content" data-role="content" aria-live="polite"></div>
					</main>
					<aside class="rms-floor-detail" data-role="detail" aria-label="${__("Table details")}" aria-live="polite"></aside>
				</div>
			</div>`);
		this.renderClock();
		this.renderDetail();
	}

	bind() {
		const root = this.page.main;
		root.on("click", "[data-area-filter]", (event) => { this.state.area = event.currentTarget.dataset.areaFilter; this.renderAreaOptions(); this.render(); });
		root.on("input", "[data-table-search]", (event) => { this.state.search = event.currentTarget.value.trim().toLocaleLowerCase(); this.render(); });
		root.on("click", "[data-floor-status-value]", event => {
			this.state.status = event.currentTarget.dataset.floorStatusValue;
			event.currentTarget.closest("details").open = false;
			this.render();
		});
		root.on("keydown", ".rms-floor-status-menu", event => {
			if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary").focus(); }
		});
		root[0].addEventListener("click", event => {
			if (!event.target.closest(".rms-floor-status-menu")) root.find(".rms-floor-status-menu").prop("open", false);
		});
		root.on("click", '[data-action="back-pos"]', (event) => { event.preventDefault(); this.pos.setContentView("menu"); });
		root.on("click", '[data-action="refresh"]', () => this.load());
		root.on("click", "[data-select-table]", (event) => this.activateTable(event.currentTarget.dataset.selectTable));
		root.on("click", '[data-action="close-detail"]', () => { this.state.selected = null; this.state.order = null; this.detailRequest++; this.render(); });
		root.on("change", "[data-check-select]", (event) => { this.state.selectedOrder = event.currentTarget.value; this.state.itemTab = null; this.loadDetail(); });
		root.on("click", "[data-floor-item-tab]", event => { this.state.itemTab = event.currentTarget.dataset.floorItemTab; this.renderDetail(); });
		root.on("click", "[data-floor-action-menu] button", event => { event.currentTarget.closest("details").open = false; });
		root.on("keydown", "[data-floor-action-menu]", event => {
			if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary").focus(); event.preventDefault(); }
		});
		root.on("click", "[data-floor-remove]", event => this.updatePendingItem(event.currentTarget.dataset.floorRemove, 0));
		root.on("click", "[data-floor-qty-step]", event => {
			const button = event.currentTarget, row = this.state.order?.items.find(row => row.order_item_name === button.dataset.item);
			if (row) this.updatePendingItem(row.order_item_name, Math.max(0, Number((Number(row.qty) + Number(button.dataset.floorQtyStep) * (row.must_be_whole_number ? 1 : .1)).toFixed(3))));
		});
		root.on("change", "[data-floor-quantity]", event => this.updatePendingItem(event.currentTarget.dataset.floorQuantity, Number(event.currentTarget.value)));

		root.on("click", '[data-action="retry-detail"]', () => this.loadDetail());
		root.on("click", "[data-new-order]", (event) => this.openTable(event.currentTarget.dataset.newOrder));
		root.on("click", '[data-action="reservations"]', () => this.showReservations());
		root.on("click", "[data-reserve-table]", (event) => this.reservationDialog(null, event.currentTarget.dataset.reserveTable));
		root.on("click", "[data-seat-reservation]", event => {
			const booking = this.state.tables.flatMap(table => table.reservations || []).find(row => row.name === event.currentTarget.dataset.seatReservation);
			if (booking) this.seatReservation(booking);
		});
		root.on("click", "[data-confirm-order]", (event) => this.confirmOrder(event.currentTarget.dataset.confirmOrder));
		root.on("click", "[data-close-table]", (event) => this.closeEmptyTable(event.currentTarget.dataset.closeTable));
		root.on("click", "[data-open-order]", (event) => this.openOrder(event.currentTarget.dataset.openOrder));
		root.on("click", "[data-print-check]", (event) => this.printCheck(event.currentTarget.dataset.printCheck));
		root.on("click", "[data-pay-order]", (event) => this.launchPOS({ store: this.state.store, order_name: event.currentTarget.dataset.payOrder, action: "pay" }));
		root.on("click", "[data-view-order]", (event) => this.viewOrder(event.currentTarget.dataset.viewOrder));
		root.on("click", "[data-transfer-order]", (event) => this.transferOrder(event.currentTarget.dataset.transferOrder));
		root.on("click", "[data-split-order]", (event) => this.splitOrder(event.currentTarget.dataset.splitOrder));
		root.on("click", "[data-merge-order]", (event) => this.mergeOrder(event.currentTarget.dataset.mergeOrder));
		root.on("click", "[data-void-order]", event => this.pos.cancelConfirmedItems([], { orderName: event.currentTarget.dataset.voidOrder, onComplete: () => this.load(true) }));
	}

	renderClock() {
		this.page.main.find('[data-role="clock"]').text(this.formatTime());
	}

	formatTime(value) {
		const zone = frappe.boot?.time_zone;
		const date = value ? moment.tz(value, frappe.defaultDatetimeFormat, zone?.system).toDate() : new Date();
		return date.toLocaleTimeString(frappe.boot?.lang || undefined, { hour: "2-digit", minute: "2-digit", timeZone: zone?.user || zone?.system });
	}

	async load(silent = false) {
		if (this.loading) return;
		this.loading = true;
		const content = this.page.main.find('[data-role="content"]');
		this.page.main.find('[data-action="refresh"]').prop("disabled", true);
		if (!silent) content.html(`<div class="rms-floor-empty"><span class="rms-tables-spinner"></span><p>${__("Loading tables…")}</p></div>`);
		try {
			const host = this.pos.state;
			if (this.state.store !== host.store) Object.assign(this.state, { area: "all", search: "", selected: null, selectedOrder: null, order: null });
			Object.assign(this.state, { stores: host.stores || [], store: host.store, session: host.session,
				permissions: host.permissions || {}, currency: host.currency, brands: host.brands || [], order_types: host.order_types || [] });
			this.state.store_title = this.state.stores.find(row => row.name === host.store)?.title || host.store;
			this.page.main.find('[data-role="session"]').text(this.state.session ? __("Session open") : __("View mode · no cashier session"));
			if (!this.state.store) {
				this.state.areas = []; this.state.tables = []; this.state.selected = null;
				this.renderAreaOptions(); this.render();
				content.html(`<div class="rms-floor-empty">${this.icon("pin")}<h2>${__("No assigned Store")}</h2><p>${__("Ask a manager to assign a Store to your POS User.")}</p></div>`);
				return;
			}
			const [areas, tables] = await Promise.all([
				this.call("get_dining_areas", { store: this.state.store }), this.call("rms.api.table_service.get_floor", { store: this.state.store }),
			]);
			this.state.session = this.pos.state.session;
			this.state.permissions = this.pos.state.permissions || {};
			this.state.areas = areas || []; this.state.tables = tables || [];
			if (!this.state.areas.some((row) => row.name === this.state.area)) this.state.area = "all";
			this.page.main.find('[data-action="refresh"]').attr("title", `${__("Refresh")} · ${this.formatTime()}`);
			this.renderAreaOptions(); this.render();
			if (this.state.selectedOrder) await this.loadDetail();
		} catch (error) {
			if (silent) frappe.show_alert({ message: __("Could not load table status"), indicator: "orange" });
			else {
				content.html(`<div class="rms-floor-empty">${this.icon("refresh")}<h2>${__("Could not load table status")}</h2><p>${__("Try refreshing the tables.")}</p><button class="btn btn-default" data-action="refresh">${__("Try again")}</button></div>`);
				this.state.selected = null; this.detailRequest++; this.renderDetail();
			}
		} finally {
			this.loading = false;
			this.page.main.find('[data-action="refresh"]').prop("disabled", false);
		}
	}

	renderAreaOptions() {
		const option = (name, title, count) => `<button type="button" data-area-filter="${this.escape(name)}" class="${this.state.area === name ? "is-active" : ""}" aria-pressed="${this.state.area === name}">${this.icon(name === "all" ? "table" : "pin")}<span>${this.escape(title)}</span><b>${count}</b></button>`;
		this.page.main.find('[data-role="areas"]').html(option("all", __("All areas"), this.state.tables.length) + this.state.areas.map((area) => option(area.name, this.floorLabel(area.title || area.name), this.state.tables.filter((table) => table.dining_area === area.name).length)).join(""));
	}

	getVisibleTables() {
		return this.state.tables.filter((table) => {
			if (this.state.area !== "all" && table.dining_area !== this.state.area) return false;
			if (this.state.status !== "all" && this.statusOf(table) !== this.state.status) return false;
			if (this.state.search) {
				const haystack = [table.title, table.name, table.dining_area_title,
					...(table.open_orders || []).flatMap((order) => [order.order, order.check_label, order.cashier, order.order_type])].join(" ").toLocaleLowerCase();
				if (!haystack.includes(this.state.search)) return false;
			}
			return true;
		});
	}

	render() {
		const visible = this.getVisibleTables();
		if (!visible.some((table) => table.name === this.state.selected)) {
			this.state.selected = null; this.state.selectedOrder = null; this.state.order = null; this.detailRequest++;
		}
		const selected = visible.find((table) => table.name === this.state.selected);
		if (selected && !(selected.open_orders || []).some((order) => order.order === this.state.selectedOrder)) {
			this.state.selectedOrder = selected.open_orders?.[0]?.order || null;
			this.state.order = null;
		}
		const areaTables = this.state.tables.filter((table) => this.state.area === "all" || table.dining_area === this.state.area);
		const statuses = [["all", __("All statuses")], ["available", __("Available")], ["occupied", __("Busy")], ["reserved", __("Reserved")], ["bill-requested", __("Bill requested")]];
		this.page.main.find("[data-floor-status-options]").html(statuses.map(([key, label]) => {
			const count = key === "all" ? areaTables.length : areaTables.filter(table => this.statusOf(table) === key).length;
			return `<button type="button" data-floor-status-value="${key}" aria-pressed="${this.state.status === key}"><i class="rms-floor-dot is-${key}"></i><span>${this.escape(label)}</span><b>${count}</b></button>`;
		}).join(""));
		const selectedStatus = statuses.find(([key]) => key === this.state.status) || statuses[0];
		this.page.main.find("[data-floor-status-label]").html(`<i class="rms-floor-dot is-${selectedStatus[0]}"></i><span>${this.escape(selectedStatus[1])}</span><span aria-hidden="true">⌄</span>`);
		this.page.main.find('[data-role="content"]').html(visible.length
			? `<div class="rms-floor-grid">${visible.map((table) => this.renderTable(table)).join("")}</div>`
			: `<div class="rms-floor-empty">${this.icon("search")}<h2>${__("No tables match these filters")}</h2><p>${__("Change the area, status or search term to see more tables.")}</p></div>`);
		this.renderDetail();
	}

	elapsed(value) {
		if (!value) return "—";
		const date = frappe.datetime.str_to_obj(value);
		const now = frappe.datetime.str_to_obj(frappe.datetime.system_datetime());
		const minutes = Math.max(0, Math.floor((now - date) / 60000));
		if (!Number.isFinite(minutes)) return "—";
		return minutes < 60 ? __("{0} min", [minutes]) : __("{0} h {1} min", [Math.floor(minutes / 60), minutes % 60]);
	}

	statusOf(table) { return table.service_status || (table.occupied ? "occupied" : "available"); }
	statusLabel(table) { return ({ available: __("Available"), occupied: __("Busy"), reserved: __("Reserved"), "bill-requested": __("Bill requested") })[this.statusOf(table)]; }

	bookingTime(value) {
		const date = moment(value), today = moment(frappe.datetime.system_datetime()).startOf("day");
		const day = date.isSame(today, "day") ? __("Today") : date.isSame(today.clone().add(1, "day"), "day") ? __("Tomorrow") : date.format("D MMM");
		return `${day} · ${this.formatTime(value)}`;
	}

	tableArt(table = {}) {
		const capacity = Number(table.capacity) || 4;
		const ends = capacity > 4
			? '<rect x="17" y="4" width="12" height="7" rx="2"/><rect x="35" y="4" width="12" height="7" rx="2"/><rect x="17" y="53" width="12" height="7" rx="2"/><rect x="35" y="53" width="12" height="7" rx="2"/>'
			: capacity > 2 ? '<rect x="23" y="4" width="18" height="7" rx="2"/><rect x="23" y="53" width="18" height="7" rx="2"/>' : "";
		return `<svg class="rms-floor-table-drawing" viewBox="0 0 64 64" aria-hidden="true"><g class="rms-floor-chair"><rect x="3" y="22" width="7" height="20" rx="2"/><rect x="54" y="22" width="7" height="20" rx="2"/>${ends}</g><rect class="rms-floor-table-surface" x="13" y="14" width="38" height="36" rx="5"/><rect class="rms-floor-table-rim" x="17" y="18" width="30" height="28" rx="3"/></svg>`;
	}

	renderTable(table) {
		const orders = table.open_orders || [];
		const oldest = orders.map((order) => order.creation).filter(Boolean).sort()[0];
		const status = this.statusOf(table), next = table.reservations?.[0];
		const overdue = orders.some(order => order.departure_overdue || (order.expected_departure && moment(order.expected_departure).isSameOrBefore(moment(frappe.datetime.system_datetime()))));
		const guests = orders.reduce((sum, order) => sum + Number(order.guest_count || 0), 0) || (status === "reserved" ? Number(next?.guests || 0) : 0);
		const title = this.tableLabel(table);
		const free = this.isFreeTable(table), action = free ? __("New order") : __("View details");
		const single = orders.length === 1 ? orders[0] : null;
		const printable = single && this.state.permissions.can_reprint_receipts && Number(single.pending_item_count) === 0 && Number(single.active_item_count) > 0 && ["Confirmed", "In Preparation", "Ready"].includes(single.status);
		const closable = single && this.state.permissions.can_checkout && this.state.session?.status === "Open" && single.cashier_session === this.state.session.name && Number(single.active_item_count) === 0 && ["Open", "Pending Confirmation"].includes(single.status);
		const shortcut = printable ? `<button type="button" class="rms-floor-card-shortcut" data-print-check="${this.escape(single.order)}" title="${__("Print check")}" aria-label="${__("Print check")}">${this.icon("print")}</button>` : closable ? `<button type="button" class="rms-floor-card-shortcut" data-close-table="${this.escape(single.order)}" title="${__("Close table")}" aria-label="${__("Close table")}">${this.icon("close")}</button>` : "";
		return `<div class="rms-floor-card is-${status} ${this.state.selected === table.name ? "is-selected" : ""} ${shortcut ? "has-shortcut" : ""}"><button type="button" class="rms-floor-card-select" data-select-table="${this.escape(table.name)}" aria-pressed="${this.state.selected === table.name}" title="${this.escape(title)}" aria-label="${this.escape(`${action}: ${title}, ${this.statusLabel(table)}`)}">
			<span class="rms-floor-card-top"><span class="rms-floor-table-art">${this.tableArt(table)}</span><span class="rms-floor-card-title"><b dir="auto">${this.escape(title)}</b></span></span>
			<span class="rms-floor-card-body">
				<span class="rms-floor-state is-${status}"><i class="rms-floor-dot is-${status}"></i>${this.statusLabel(table)}${orders.length > 1 ? `<small>· ${__("{0} checks", [orders.length])}</small>` : ""}</span>
				<span class="rms-floor-card-meta ${oldest ? "" : "is-idle"}"><span title="${guests ? __("Guests") : __("Capacity")}">${this.icon(guests ? "user" : "seats")}<span>${this.escape(guests || table.capacity || 0)} ${guests ? __("guests") : __("seats")}</span></span>${oldest ? `<span title="${__("Order time")}">${this.icon("clock")}<span>${this.escape(this.elapsed(oldest))}</span></span>` : ""}</span>
				${next ? `<span class="rms-floor-next-booking ${orders.length && moment(next.starts_at).isSameOrBefore(moment(frappe.datetime.system_datetime())) ? "is-due" : ""}" title="${this.escape(`${frappe.datetime.str_to_user(next.starts_at)} · ${next.guest_name}`)}">${this.icon("calendar")}<span>${this.escape(this.bookingTime(next.starts_at))} · ${this.escape(next.guest_name)}</span></span>` : ""}
				${overdue ? `<span class="rms-floor-visit-alert">${this.icon("clock")}${__("Stay time exceeded")}</span>` : ""}
				<span class="rms-floor-card-details">${action}</span>
			</span>
		</button>${shortcut}</div>`;
	}

	activateTable(name) {
		const table = this.state.tables.find(row => row.name === name);
		if (!table) return;
		if (this.isFreeTable(table)) return this.openTable(name);
		this.selectTable(name);
	}

	selectTable(name, scroll = true) {
		this.state.selected = name;
		this.state.selectedOrder = this.state.tables.find((table) => table.name === name)?.open_orders?.[0]?.order || null;
		this.state.order = null; this.state.tab = "order"; this.state.itemTab = null; this.detailError = false; this.detailLoading = false;
		this.detailRequest++;
		this.render();
		if (this.state.selectedOrder) this.loadDetail();
		if (scroll && window.matchMedia("(max-width: 900px)").matches) this.page.main.find('[data-role="detail"]')[0]?.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	async loadDetail() {
		const name = this.state.selectedOrder;
		if (!name) return;
		const request = ++this.detailRequest;
		if (this.state.order?.name !== name) this.state.order = null;
		this.detailLoading = true; this.detailError = false; this.renderDetail();
		try {
			const order = await this.call("rms.api.table_service.get_table_order", { order_name: name });
			if (request !== this.detailRequest) return;
			order.merge_candidates = [];
			if (this.state.permissions.can_merge_orders && this.state.session?.status === "Open" && order.cashier_session === this.state.session.name && !Number(order.pending_item_count) && !(order.items || []).some(row => Number(row.qty) > 0 && !row.sent_to_kitchen) && !order.guest_checks?.length) {
				try { order.merge_candidates = (await this.call("rms.api.table_service.get_merge_candidates", { order_name: name })).filter(row => row.dining_table && row.dining_table !== order.dining_table); } catch (_) { /* The menu stays hidden if eligibility cannot be verified. */ }
			}
			if (request !== this.detailRequest) return;
			this.state.order = order;
		} catch (_) {
			if (request !== this.detailRequest) return;
			this.state.order = null;
			this.detailError = true;
		} finally {
			if (request === this.detailRequest) { this.detailLoading = false; this.renderDetail(); }
		}
	}


	renderDetail() {
		const detail = this.page.main.find('[data-role="detail"]');
		const previousScroll = detail.find(".rms-pos-cart-lines")[0]?.scrollTop || 0;
		const sameOrder = this.renderedOrder === this.state.selectedOrder;
		const previousTab = this.renderedItemTab;
		const actionsOpen = detail.find("[data-floor-action-menu]")[0]?.open;
		this.renderedOrder = this.state.selectedOrder;
		const table = this.state.tables.find(row => row.name === this.state.selected);
		detail.prop("hidden", !table);
		this.page.main.find(".rms-floor-layout").toggleClass("has-selected-table", Boolean(table));
		if (!table) { detail.empty(); return; }
		const summary = (table.open_orders || []).find(row => row.order === this.state.selectedOrder);
		const order = this.state.order;
		const header = `<header class="rms-pos-cart-head"><div class="rms-pos-head-context"><h2>${this.escape(this.tableLabel(table))}</h2></div><button type="button" class="rms-floor-close" data-action="close-detail" aria-label="${__("Close details")}">${this.icon("close")}</button></header>`;
		if (!table.occupied || !summary) {
			detail.html(`${header}${this.renderBookings(table)}<div class="rms-floor-table-idle"><h3>${table.occupied ? __("This table has an active order") : table.reserved ? __("Reserved") : __("Ready for the next guests")}</h3><p>${table.occupied ? __("Order details are not available with your current permissions.") : table.reserved ? __("Seat the reservation when your guests arrive.") : __("Start a new check when your guests are seated.")}</p></div>${this.renderIdleActions(table)}`);
			return;
		}
		const checks = (table.open_orders || []).length > 1 ? `<label class="rms-floor-check-picker"><span>${__("Open checks")}</span><select data-check-select aria-label="${__("Open checks")}">${table.open_orders.map(row => `<option value="${this.escape(row.order)}" ${row.order === this.state.selectedOrder ? "selected" : ""}>${this.escape(row.check_label || this.pos.orderNumber(row.order))}</option>`).join("")}</select></label>` : "";
		const customer = `<div class="rms-pos-order-meta"><span class="rms-pos-meta-button" aria-label="${__("Customer")}">${this.escape(order?.customer || __("Walk-in Customer"))}</span></div>`;
		const notes = order?.order_notes ? `<div class="rms-pos-order-comment"><p>${this.escape(order.order_notes)}</p></div>` : "";
		let body = `<div class="rms-floor-detail-message"><span class="rms-tables-spinner"></span>${__("Loading order…")}</div>`;
		if (this.detailError) body = `<div class="rms-floor-detail-message"><p>${__("Could not load order details")}</p><button class="btn btn-default" data-action="retry-detail">${__("Try again")}</button></div>`;
		else if (order) body = this.renderOrder(order);
		const hasItems = (order?.items || []).some(row => Number(row.qty) > 0);
		const footer = order ? `<footer class="rms-pos-summary ${hasItems ? "" : "rms-floor-empty-footer"}">${hasItems ? this.pos.cartTotalsHTML(order, { roles: false, payableTotal: order.payable_total ?? order.grand_total }) : ""}${this.renderActions(order)}</footer>` : "";
		detail.html(`${header}${order?.expected_departure ? `<div class="rms-floor-visit-limit ${moment(order.expected_departure).isSameOrBefore(moment(frappe.datetime.system_datetime())) ? "is-overdue" : ""}">${this.icon("clock")}${__("Expected departure")}: ${this.escape(this.formatTime(order.expected_departure))}</div>` : ""}${customer}${notes}${checks}${body}${footer}`);
		this.renderedItemTab = this.state.itemTab;
		if (sameOrder && previousTab === this.state.itemTab) {
			const list = detail.find(".rms-pos-cart-lines")[0];
			if (list) list.scrollTop = previousScroll;
		}
		if (sameOrder && actionsOpen) {
			const menu = detail.find("[data-floor-action-menu]")[0];
			if (menu) menu.open = true;
		}
	}

	renderBookings(table) {
		return (table.reservations || []).slice(0, 2).map(row => `<div class="rms-floor-booking-hint">${this.icon("calendar")}<div><b>${this.escape(row.guest_name)}</b><span>${this.escape(frappe.datetime.str_to_user(row.starts_at))} · ${this.escape(row.guests)} ${__("guests")}</span></div></div>`).join("");
	}

	renderIdleActions(table) {
		const reserve = `<button type="button" class="rms-floor-secondary" data-reserve-table="${this.escape(table.name)}">${this.icon("calendar")}${__("Reserve table")}</button>`;
		if (!table.occupied && this.state.session?.status === "Open" && this.state.permissions.can_checkout) {
			const booking = table.reservations?.[0];
			const canSeat = booking && moment(booking.ends_at).isAfter(moment(frappe.datetime.system_datetime()));
			const seat = canSeat ? `<button type="button" class="rms-floor-primary" data-seat-reservation="${this.escape(booking.name)}">${this.icon("user")}${__("Seat guests")}</button>` : "";
			const walkIn = !table.reserved ? `<button type="button" class="${booking ? "rms-floor-secondary" : "rms-floor-primary"}" data-new-order="${this.escape(table.name)}">${this.icon("plus")}${booking ? __("Open table before reservation") : __("Open table")}</button>` : "";
			const note = booking ? `<p class="rms-floor-access-note">${canSeat ? __("Early arrivals can be seated if a suitable table is free. Any earlier walk-in must finish before this booking.") : __("This reservation has ended. Review its time before seating guests.")}</p>` : "";
			return `<div class="rms-floor-idle-actions">${note}${seat}${walkIn}${reserve}</div>`;
		}
		const note = table.occupied ? "" : !this.state.session ? __("Open your cashier session before creating a table order.") : __("Your POS profile does not allow creating orders.");
		return `<div class="rms-floor-idle-actions">${note ? `<p class="rms-floor-access-note">${note}</p>` : ""}<button type="button" class="rms-floor-primary" data-action="back-pos">${__("Back to POS")}${this.icon("arrow")}</button>${reserve}</div>`;
	}


	renderOrder(order) {
		const groups = { pending: [], confirmed: [] };
		const own = this.state.session?.status === "Open" && order.cashier_session === this.state.session.name;
		const canEdit = own && this.state.permissions.can_checkout && !order.guest_checks?.length;
		for (const row of (order.items || []).filter(row => Number(row.qty) > 0)) {
			const pending = !row.sent_to_kitchen;
			groups[pending ? "pending" : "confirmed"].push(this.pos.cartItemHTML(row, {
				scope: "floor", editable: pending && canEdit, pending, quantity: Number(row.qty), amount: Number(row.amount),
			}));
		}
		if (!["pending", "confirmed"].includes(this.state.itemTab)) this.state.itemTab = groups.pending.length ? "pending" : "confirmed";
		if (this.state.itemTab === "pending" && this.lastPendingCount > 0 && !groups.pending.length) this.state.itemTab = "confirmed";
		this.lastPendingCount = groups.pending.length;
		const tabs = `<div class="rms-pos-cart-tabs" role="tablist" aria-label="${__("Item confirmation")}">${[["pending", __("Not confirmed")], ["confirmed", __("Confirmed")]].map(([key, title]) => `<button type="button" role="tab" id="rms-floor-items-${key}" aria-controls="rms-floor-item-panel" aria-selected="${this.state.itemTab === key}" data-tab="${key}" data-floor-item-tab="${key}">${title}<span>${groups[key].length}</span></button>`).join("")}</div>`;
		const empty = this.state.itemTab === "pending" ? __("No unconfirmed items") : __("No confirmed items yet");
		return `${tabs}<div class="rms-pos-cart-lines rms-floor-items" id="rms-floor-item-panel" role="tabpanel" aria-labelledby="rms-floor-items-${this.state.itemTab}"><section class="rms-cart-section is-${this.state.itemTab}">${groups[this.state.itemTab].join("") || `<p class="rms-cart-tab-empty">${empty}</p>`}</section></div>`;
	}
	renderNotes(order) {
		const itemNotes = (order.items || []).filter((row) => row.notes && Number(row.qty) > 0);
		return `<div class="rms-floor-notes">${order.order_notes ? `<article><h3>${__("Order notes")}</h3><p>${this.escape(order.order_notes)}</p></article>` : ""}${itemNotes.map((row) => `<article><h3>${this.escape(row.title)}</h3><p>${this.escape(row.notes)}</p></article>`).join("")}${!order.order_notes && !itemNotes.length ? `<div class="rms-floor-detail-message">${this.icon("note")}<p>${__("No notes on this check.")}</p></div>` : ""}</div>`;
	}


	renderActions(order) {
		const p = this.state.permissions;
		const own = this.state.session?.status === "Open" && order.cashier_session === this.state.session.name;
		const confirmed = ["Confirmed", "In Preparation", "Ready"].includes(order.status);
		const hasItems = (order.items || []).some(row => Number(row.qty) > 0);
		const canEdit = this.state.session?.status === "Open" && p.can_checkout && (own || p.can_edit_open_orders);
		const action = (attribute, title, icon, enabled = true, className = "", iconOnly = false) => `<button type="button" class="${className}" ${attribute}="${this.escape(order.name)}" ${enabled ? "" : "disabled"} title="${title}" aria-label="${title}">${this.icon(icon)}<span class="${iconOnly ? "sr-only" : ""}">${title}</span></button>`;
		const pending = Number(order.pending_item_count || 0) > 0 || (order.items || []).some(row => Number(row.qty) > 0 && !row.sent_to_kitchen);
		if (pending) return `<div class="rms-floor-primary-actions">${canEdit ? action("data-confirm-order", __("Confirm"), "check", !this.itemMutation && !this.confirmingOrder, "rms-pos-checkout rms-floor-confirm") : `<p class="rms-floor-access-note">${__("Continue this order from its cashier session")}</p>`}</div>`;
		const canPay = own && p.can_checkout && confirmed && hasItems;
		if (!hasItems && ["Open", "Pending Confirmation"].includes(order.status)) return `<div class="rms-floor-empty-actions">${canEdit ? action("data-open-order", __("Add items"), "plus", true, "rms-floor-empty-add") : ""}${own && p.can_checkout ? action("data-close-table", __("Close table"), "close", true, "rms-floor-empty-close") : ""}</div>`;
		const buttons = [
			own && p.can_transfer_tables ? action("data-transfer-order", __("Move table"), "move") : "",
			own && p.can_split_orders && p.can_checkout && (order.items || []).filter(row => Number(row.qty) > 0).length > 1 && !order.guest_checks?.length && (this.state.tables || []).some(table => table.name !== order.dining_table && this.isFreeTable(table)) ? action("data-split-order", __("Split to table"), "split") : "",
			own && p.can_merge_orders && (order.merge_candidates || []).length ? action("data-merge-order", __("Merge checks"), "merge") : "",
			p.can_reprint_receipts ? action("data-print-check", __("Print check"), "print", confirmed && hasItems) : "",
			own && (hasItems || p.can_checkout) ? action(hasItems ? "data-void-order" : "data-close-table", hasItems ? __("Void") : __("Close table"), "close", true, "is-danger") : "",
		].filter(Boolean).join("");
		const menu = buttons ? `<details class="rms-floor-action-menu" data-floor-action-menu><summary title="${__("Table actions")}" aria-label="${__("Table actions")}"><span aria-hidden="true">⋯</span></summary><div class="rms-floor-action-list" role="group" aria-label="${__("Table actions")}">${buttons}</div></details>` : "";
		return `<div class="rms-floor-primary-actions">${canEdit ? action("data-open-order", __("Add items"), "plus", true, "rms-floor-add-items", canPay) : ""}${menu}${canPay ? action("data-pay-order", __("Take payment"), "check", true, "rms-pos-checkout") : ""}</div>`;
	}

	async dialogAction(dialog, action) {
		const button = dialog.get_primary_btn();
		if (dialog.rmsSubmitting || button.prop("disabled")) return;
		dialog.rmsSubmitting = true; button.prop("disabled", true);
		try { await action(); }
		catch (error) { this.showError(error); }
		finally { dialog.rmsSubmitting = false; if (dialog.rmsUpdate) dialog.rmsUpdate(); else button.prop("disabled", false); }
	}

	async openTable(name, reservation = null, tableOverride = null) {
		if (this.newOrderDialog?.is_visible) return;
		const table = tableOverride || this.state.tables.find(row => row.name === name);
		if (!table) return;
		if (table.occupied || table.open_orders?.length) { this.selectTable(name); return; }
		const store = this.state.store;
		const chosenType = this.pos.state.order_types?.find(row => row.name === this.pos.state.order_type && row.require_table && !row.require_external_reference)?.name;
		const current = reservation || (table.reservations || []).find(row => frappe.datetime.str_to_obj(row.starts_at) <= frappe.datetime.str_to_obj(frappe.datetime.system_datetime()));
		const next = !current && (table.reservations || []).find(row => moment(row.starts_at).isAfter(moment(frappe.datetime.system_datetime())) && moment(row.starts_at).diff(moment(frappe.datetime.system_datetime()), "minutes") <= 720);
		const early = current && moment(current.starts_at).isAfter(moment(frappe.datetime.system_datetime()));
		const minutesAvailable = next ? Math.max(0, moment(next.starts_at).diff(moment(frappe.datetime.system_datetime()), "minutes")) : null;
		let expectedDeparture = null;
		const fields = [
			{ fieldtype: "HTML", fieldname: "table_intro", options: `<div class="rms-floor-dialog-intro">${this.tableArt(table)}<div><b>${this.escape(this.tableLabel(table))}</b><span>${this.escape(table.capacity)} ${__("seats")}</span>${current ? `<p>${__("Reservation")}: ${this.escape(current.guest_name)}</p><p>${early ? __("Early arrival") + " · " : ""}${this.escape(this.bookingTime(current.starts_at))} → ${this.escape(this.formatTime(current.ends_at))}</p>` : ""}</div></div>` },
			...(next ? [{fieldtype:"HTML",fieldname:"stay_limit",options:`<div class="rms-stay-limit"><div>${this.icon("calendar")}<b>${__("Reserved at {0}",[this.escape(this.formatTime(next.starts_at))])}</b></div><p>${__("Available for {0} minutes. Choose how long these guests will stay.",[minutesAvailable])}</p><div class="rms-stay-options">${[30,45,60,90,120].filter(value=>value<minutesAvailable).map(value=>`<button type="button" data-stay-minutes="${value}" aria-pressed="false">${value} ${__("min")}</button>`).join("")}${minutesAvailable>0?`<button type="button" data-stay-until="${this.escape(next.starts_at)}" aria-pressed="false">${__("Until {0}",[this.escape(this.formatTime(next.starts_at))])}</button>`:""}</div><button type="button" class="rms-stay-other" data-open-other-table>${__("Need more time? Choose another table")}${this.icon("arrow")}</button></div>`}] : []),
			{ fieldtype: "Int", fieldname: "guests", label: __("Guests"), default: current?.guests || Math.min(2, Number(table.capacity || 1)), reqd: 1, read_only: Boolean(current) },
			{ fieldtype: "HTML", fieldname: "customer_picker", options: `<label class="control-label">${__("Customer")}</label>${this.pos.customerPickerHTML()}` },
		];
		const dialog = new frappe.ui.Dialog({ title: current ? __("Seat guests") : __("NEW ORDER"), fields,
			primary_action_label: early ? __("Seat guests early") : __("Confirm"), primary_action: values => this.dialogAction(dialog, async () => {
				if (!this.pos.state.permissions.can_checkout) throw new Error(__("Your POS profile does not allow creating orders."));
				if (this.pos.state.session?.status !== "Open") throw new Error(__("Open your cashier session before creating a table order."));
				const guests = Number(values.guests);
				if (!Number.isInteger(guests) || guests < 1 || guests > Number(table.capacity)) {
					throw new Error(__("Enter a whole number of guests between 1 and {0}.", [table.capacity]));
				}
				if (next && !expectedDeparture) throw new Error(__("Choose a stay that ends before the reservation."));
				const order = await this.call("rms.api.table_service.open_table", { store, dining_table: name, guests, restaurant_brand: this.pos.state.brand,
					customer: dialog.selectedCustomer || null, reservation: current?.name, expected_departure: expectedDeparture,
					order_type: chosenType });
				dialog.hide();
				await this.launchPOS({ store, order_name: order.name });
			}) });
		this.newOrderDialog = dialog;
		dialog.onhide = () => { if (this.newOrderDialog === dialog) this.newOrderDialog = null; };
		dialog.on_page_show = () => { this.newOrderDialog = dialog; };
		dialog.$wrapper.addClass("rms-floor-service-dialog rms-floor-new-order-dialog");
		const guestField = dialog.fields_dict.guests;
		if (!current) {
			guestField.$input.attr({ min: 1, max: table.capacity, step: 1, inputmode: "numeric" });
			guestField.$input.parent().addClass("rms-floor-guest-stepper")
				.prepend(`<button type="button" data-guest-step="-1" aria-label="${__("Fewer guests")}">−</button>`)
				.append(`<button type="button" data-guest-step="1" aria-label="${__("More guests")}">+</button>`);
			const updateSteps = () => {
				const guests = Number(guestField.$input.val());
				dialog.$wrapper.find('[data-guest-step="-1"]').prop("disabled", guests <= 1);
				dialog.$wrapper.find('[data-guest-step="1"]').prop("disabled", guests >= Number(table.capacity));
			};
			guestField.$input.on("input change", updateSteps);
			dialog.$wrapper.on("shown.bs.modal", updateSteps);
			dialog.$wrapper.on("click", "[data-guest-step]", async event => {
				const guests = Number(dialog.get_value("guests")) || 1;
				await dialog.set_value("guests", Math.max(1, Math.min(Number(table.capacity), guests + Number(event.currentTarget.dataset.guestStep))));
				updateSteps();
			});
			updateSteps();
		}
		dialog.show();
		await this.pos.setupCustomerPicker(dialog, { customer: this.pos.state.default_customer || null, allowWalkIn: true, autofocus: false, compact: true });
		if (next) {
			const update = () => {
				const input = String(dialog.$wrapper.find("[data-customer-search]").val() || "").trim();
				dialog.get_primary_btn().prop("disabled",Boolean(dialog.rmsSubmitting || !expectedDeparture || (input && !dialog.selectedCustomer)));
			};
			dialog.rmsUpdate = update;
			const selectCustomer = dialog.selectCustomer;
			dialog.selectCustomer = (...args) => { selectCustomer(...args); update(); };
			dialog.$wrapper.on("click", "[data-stay-minutes],[data-stay-until]", event => {
				const button = event.currentTarget;
				expectedDeparture = button.dataset.stayUntil || moment(frappe.datetime.system_datetime()).add(Number(button.dataset.stayMinutes),"minutes").format("YYYY-MM-DD HH:mm:ss");
				dialog.$wrapper.find("[data-stay-minutes],[data-stay-until]").attr("aria-pressed","false"); $(button).attr("aria-pressed","true"); update();
			});
			dialog.$wrapper.on("input", "[data-customer-search]", () => setTimeout(update,0));
			dialog.$wrapper.on("click", "[data-open-other-table]", () => this.chooseWalkInTable(table.name, Number(dialog.get_value("guests")), dialog));
			update();
		}
	}

	async chooseWalkInTable(current, guests, parentDialog) {
		try {
			const tables = await this.call("rms.api.table_service.get_floor",{store:this.state.store});
			const choices = tables.filter(table => table.name !== current && this.isFreeTable(table) && Number(table.capacity) >= guests);
			if (!choices.length) return frappe.msgprint(__("No unreserved table fits these guests. Use a shorter stay or wait for a table."));
			let selected=null;
			const dialog = new frappe.ui.Dialog({title:__("Choose another table"),fields:[{fieldtype:"HTML",fieldname:"tables",options:`<div class="rms-res-table-grid">${choices.map(table=>`<button type="button" data-walkin-table="${this.escape(table.name)}" aria-pressed="false">${this.tableArt(table)}<b>${this.escape(this.tableLabel(table))}</b><small>${table.capacity} ${__("seats")}</small></button>`).join("")}</div>`}],primary_action_label:__("Continue"),primary_action:()=>{if(selected){dialog.hide();this.state.tables=tables;parentDialog.$wrapper.one("hidden.bs.modal",()=>this.openTable(selected));parentDialog.hide();}}});
			dialog.$wrapper.addClass("rms-floor-service-dialog rms-reservation-dialog");dialog.$wrapper.on("click","[data-walkin-table]",event=>{selected=event.currentTarget.dataset.walkinTable;dialog.$wrapper.find("[data-walkin-table]").each((_,el)=>el.setAttribute("aria-pressed",el.dataset.walkinTable===selected));dialog.get_primary_btn().prop("disabled",false);});dialog.show();dialog.get_primary_btn().prop("disabled",true);
		} catch(error) { this.showError(error); }
	}

	async updatePendingItem(itemName, qty) {
		if (this.itemMutation || this.confirmingOrder) return;
		const order = this.state.order;
		if (!order || !Number.isFinite(qty) || qty < 0) { this.renderDetail(); return; }
		this.itemMutation = true;
		this.page.main.find('[data-role="detail"] button, [data-floor-quantity]').prop("disabled", true);
		try {
			await this.pos.flushDraftSave();
			await this.call("rms.api.table_service.update_pending_item", { order_name: order.name, item_name: itemName, qty, expected_modified: order.modified });
			if (this.pos.state.order_name === order.name) await this.pos.loadOrder(await this.call("get_order", { order_name: order.name }), { deferMenu: true });
			await this.load(true);
		} catch (error) { this.showError(error); await this.loadDetail(); }
		finally { this.itemMutation = false; this.renderDetail(); }
	}

	async confirmOrder(name) {
		if (this.confirmingOrder || this.itemMutation) return;
		this.confirmingOrder = true; this.renderDetail();
		try { await this.pos.flushDraftSave(); await this.call("confirm_order", { order_name: name }); if (this.pos.state.order_name === name) await this.pos.loadOrder(await this.call("get_order", { order_name: name }), { deferMenu: true }); await this.load(true); frappe.show_alert({ message: __("Order confirmed and sent to preparation"), indicator: "green" }); }
		catch (error) { this.showError(error); }
		finally { this.confirmingOrder = false; this.renderDetail(); }
	}

	closeEmptyTable(name) {
		frappe.confirm(__("Close this empty table?"), async () => {
			try { await this.call("rms.api.table_service.close_empty_table", { order_name: name }); await this.load(true); }
			catch (error) { this.showError(error); }
		});
	}

	reservationDialog(reservation = null, tableName = null, onSaved = null) {
		if (!this.state.store) return;
		let step = 1, tables = [], request = 0, loading = false;
		const now = moment(frappe.datetime.system_datetime());
		const initial = reservation ? moment(reservation.starts_at) : now.clone().add(30 - now.minute() % 30, "minutes").seconds(0);
		const state = { date: initial.format("YYYY-MM-DD"), time: initial.format("HH:mm"),
			duration: reservation ? moment(reservation.ends_at).diff(initial, "minutes") : 120,
			guests: Number(reservation?.guests || 2), table: reservation?.dining_table || tableName || null };
		let slotStart = Math.max(0, Math.min(16, Math.floor(initial.hour() / 4) * 4));
		const canCollect = this.state.session?.status === "Open" && this.state.permissions.can_checkout;
		const paymentMethods = (this.pos.state.payment_config || []).filter(row => row.mode_of_payment !== "RMS Reservation Deposit");
		const requestId = window.crypto.randomUUID();
		const esc = value => this.escape(value);
		const html = `<div class="rms-res-wizard"><div class="rms-res-progress"><span data-res-step-pill="1">1 · ${__("When & guests")}</span><span data-res-step-pill="2">2 · ${__("Table & booking")}</span></div>
			<section data-res-step="1"><div class="rms-res-section-label">${this.icon("calendar")}${__("Date")}</div><div class="rms-res-date-row"><button type="button" data-res-day="0">${__("Today")}</button><button type="button" data-res-day="1">${__("Tomorrow")}</button><input type="date" data-res-date value="${state.date}" min="${now.format("YYYY-MM-DD")}" aria-label="${__("Reservation date")}"></div>
			<div class="rms-res-section-label">${this.icon("clock")}${__("Arrival time")}<span class="rms-res-slot-nav"><button type="button" data-res-hours="-4" aria-label="${__("Earlier times")}">‹</button><button type="button" data-res-hours="4" aria-label="${__("Later times")}">›</button></span></div><div class="rms-res-time-grid" data-res-slots></div><label class="rms-res-custom-time">${__("Other time")}<input type="text" data-res-time value="${state.time}" placeholder="19:30" inputmode="numeric" maxlength="5" dir="ltr" aria-label="${__("Arrival time, 24-hour format")}"></label>
			<div class="rms-res-bottom-row"><div><div class="rms-res-section-label">${__("Duration")}</div><div class="rms-res-duration">${[60,90,120,180].map(value => `<button type="button" data-res-duration="${value}">${value === 60 ? __("1 hour") : value === 90 ? __("1½ hours") : value === 120 ? __("2 hours") : __("3 hours")}</button>`).join("")}</div></div><div><div class="rms-res-section-label">${__("Guests")}</div><div class="rms-res-party"><button type="button" data-res-guests="-1">−</button><input type="number" data-res-party value="${state.guests}" min="1" max="100" step="1" aria-label="${__("Guests")}"><button type="button" data-res-guests="1">+</button></div></div></div></section>
			<section data-res-step="2" hidden><div class="rms-res-summary" data-res-summary></div><div class="rms-res-section-label">${this.icon("table")}${__("Choose a table")}<small data-res-available></small></div><div class="rms-res-table-grid" data-res-tables></div><p class="rms-res-error" data-res-error role="alert" hidden></p>
			<div class="rms-res-guest-fields"><label>${__("Guest name")}<input type="text" data-res-name maxlength="140" autocomplete="name" value="${esc(reservation?.guest_name || "")}"></label><label>${__("Phone")}<input type="tel" data-res-phone maxlength="40" autocomplete="tel" dir="ltr" value="${esc(reservation?.phone || "")}"></label></div>
			<details class="rms-res-extra"><summary>${this.icon("note")}${__("Add a note")}</summary><textarea data-res-notes maxlength="2000" rows="2" placeholder="${__("Special occasion, seating preference…")}">${esc(reservation?.notes || "")}</textarea></details>
			<div class="rms-res-deposit"><label class="rms-res-deposit-toggle"><input type="checkbox" data-res-with-deposit ${canCollect && paymentMethods.length ? "" : "disabled"}><span><b>${__("Collect a deposit")}</b><small>${canCollect ? __("Optional · deducted from the final bill") : __("Save without a deposit, or open your cashier session to collect one.")}</small></span></label><div data-res-deposit-fields hidden><label>${__("Amount")}<input type="number" data-res-deposit-amount min="0.01" step="0.01" inputmode="decimal" placeholder="0.00"></label><div class="rms-res-payment-methods" role="group" aria-label="${__("Payment method")}">${paymentMethods.map((row,index) => `<label><input type="radio" name="res-method-${requestId}" value="${esc(row.mode_of_payment)}" ${index === 0 ? "checked" : ""}>${esc(row.mode_of_payment)}</label>`).join("")}</div></div></div></section></div>`;
		const interval = () => {
			const start = moment(`${state.date} ${state.time}`, "YYYY-MM-DD HH:mm", true);
			if (!start.isValid() || start.isBefore(now.clone().subtract(5,"minutes"))) throw Error(__("Choose a future reservation time."));
			return { starts_at: start.format("YYYY-MM-DD HH:mm:ss"), ends_at: start.clone().add(state.duration,"minutes").format("YYYY-MM-DD HH:mm:ss") };
		};
		const dialog = new frappe.ui.Dialog({ title: reservation ? __("Edit reservation") : __("New reservation"), size: "large", fields: [{fieldtype:"HTML",fieldname:"reservation_ui",options:html}],
			primary_action_label: __("Choose a table"), primary_action: () => {
				if (step === 1) { try { interval(); step = 2; update(); loadTables(); } catch(error) { this.showError(error); } return; }
				return this.dialogAction(dialog, async () => {
					const table = tables.find(row => row.name === state.table && row.bookable);
					if (!table) throw Error(__("Choose an available table."));
					const name = root.find("[data-res-name]").val().trim(), phone = root.find("[data-res-phone]").val().trim();
					if (!name || !phone) throw Error(__("Enter the guest name and contact phone."));
					const data = { store:this.state.store, dining_table:state.table, guests:state.guests, guest_name:name, phone, ...interval(), notes:root.find("[data-res-notes]").val() };
					if (root.find("[data-res-with-deposit]").prop("checked")) {
						const amount = Number(root.find("[data-res-deposit-amount]").val());
						if (!Number.isFinite(amount) || amount <= 0) throw Error(__("Enter a deposit amount greater than zero."));
						data.deposit = { amount, mode_of_payment:root.find(".rms-res-payment-methods input:checked").val(), request_id:requestId };
					}
					await this.call("rms.api.table_service.save_reservation", {data:JSON.stringify(data),name:reservation?.name,expected_modified:reservation?.modified});
					dialog.hide(); await this.load(true); await onSaved?.(); frappe.show_alert({message:__("Reservation saved"),indicator:"green"});
				});
			} });
		dialog.$wrapper.addClass("rms-floor-service-dialog rms-reservation-dialog");
		const root = dialog.$wrapper;
		root.find(".modal-footer").prepend(`<button type="button" class="rms-res-secondary" data-res-back hidden>${__("Back")}</button>`);
		const renderSlots = () => {
			root.find("[data-res-slots]").html(Array.from({length:16}, (_,index) => {
				const time = moment(state.date).startOf("day").add(slotStart * 60 + index * 30,"minutes"), value=time.format("HH:mm");
				return `<button type="button" data-res-slot="${value}" aria-pressed="${state.time === value}" ${time.isBefore(now) ? "disabled" : ""}>${time.format("h:mm A")}</button>`;
			}).join(""));
		};
		const update = () => {
			root.find("[data-res-step]").each((_,el) => {el.hidden=Number(el.dataset.resStep)!==step;});
			root.find("[data-res-step-pill]").each((_,el) => el.classList.toggle("is-active",Number(el.dataset.resStepPill)===step));
			root.find("[data-res-back]").prop("hidden",step!==2);
			root.find("[data-res-day]").each((_,el) => el.setAttribute("aria-pressed",moment().add(Number(el.dataset.resDay),"days").format("YYYY-MM-DD")===state.date));
			root.find("[data-res-duration]").each((_,el) => el.setAttribute("aria-pressed",Number(el.dataset.resDuration)===state.duration));
			root.find("[data-res-summary]").html(`${this.icon("calendar")}<b>${esc(moment(state.date).format("ddd, D MMM"))}</b><span>${esc(moment(`${state.date} ${state.time}`).format("h:mm A"))} · ${state.duration} ${__("min")} · ${state.guests} ${__("guests")}</span>`);
			dialog.get_primary_btn().text(step===1 ? __("Choose a table") : reservation ? __("Save changes") : __("Confirm reservation")).prop("disabled",Boolean(dialog.rmsSubmitting || loading || (step===2 && !tables.some(row=>row.name===state.table && row.bookable))));
			renderSlots();
		};
		const loadTables = async () => {
			const token = ++request; loading=true; root.find("[data-res-tables]").html(`<p>${__("Finding available tables…")}</p>`); update();
			root.find("[data-res-error]").prop("hidden",true);
			try {
				const result = await this.call("rms.api.table_service.get_reservation_tables",{store:this.state.store,...interval(),guests:state.guests,exclude:reservation?.name});
				if (token!==request) return;
				tables=result || []; if (!tables.some(row=>row.name===state.table&&row.bookable)) state.table=null;
				root.find("[data-res-available]").text(__("{0} available",[tables.filter(row=>row.bookable).length]));
				root.find("[data-res-tables]").html(tables.map(row=>`<button type="button" data-res-table="${esc(row.name)}" aria-pressed="${state.table===row.name}" ${row.bookable?"":"disabled"}>${this.tableArt(row)}<b>${esc(this.tableLabel(row))}</b><small>${row.capacity} ${__("seats")}</small>${row.bookable?(row.availability_note?`<em class="is-notice">${esc(row.availability_note)}</em>`:""):`<em>${esc(row.unavailable_reason)}</em>`}</button>`).join("") || `<p>${__("No tables are configured for this Store.")}</p>`);
			} catch(error) { if(token===request) { tables=[];root.find("[data-res-error]").text(__("Could not load availability. Go back and try again.")).prop("hidden",false); } this.showError(error); }
			finally {if(token===request){loading=false;update();}}
		};
		root.on("click","[data-res-back]",()=>{step=1;update();});
		root.on("click","[data-res-day]",event=>{state.date=now.clone().add(Number(event.currentTarget.dataset.resDay),"days").format("YYYY-MM-DD");root.find("[data-res-date]").val(state.date);update();});
		root.on("change","[data-res-date]",event=>{state.date=event.target.value;update();});
		root.on("click","[data-res-slot]",event=>{state.time=event.currentTarget.dataset.resSlot;root.find("[data-res-time]").val(state.time);update();});
		root.on("change","[data-res-time]",event=>{state.time=event.target.value;update();});
		root.on("click","[data-res-hours]",event=>{slotStart=Math.max(0,Math.min(16,slotStart+Number(event.currentTarget.dataset.resHours)));renderSlots();});
		root.on("click","[data-res-duration]",event=>{state.duration=Number(event.currentTarget.dataset.resDuration);update();});
		root.on("click","[data-res-guests]",event=>{state.guests=Math.max(1,Math.min(100,state.guests+Number(event.currentTarget.dataset.resGuests)));root.find("[data-res-party]").val(state.guests);update();});
		root.on("change","[data-res-party]",event=>{state.guests=Math.max(1,Math.round(Number(event.target.value)||1));event.target.value=state.guests;update();});
		root.on("click","[data-res-table]",event=>{state.table=event.currentTarget.dataset.resTable;root.find("[data-res-table]").each((_,el)=>el.setAttribute("aria-pressed",el.dataset.resTable===state.table));update();});
		root.on("change","[data-res-with-deposit]",event=>root.find("[data-res-deposit-fields]").prop("hidden",!event.target.checked));
		dialog.rmsUpdate=update;dialog.show();update();return dialog;
	}

	showReservations() {
		if (!this.state.store) return;
		let rows=[],request=0,date=frappe.datetime.now_date(),filter="active";
		const dialog=new frappe.ui.Dialog({title:__("Reservations"),size:"large",fields:[{fieldtype:"HTML",fieldname:"bookings",options:`<div class="rms-res-list-toolbar"><div class="rms-res-date-row"><button type="button" data-booking-day="0">${__("Today")}</button><button type="button" data-booking-day="1">${__("Tomorrow")}</button><input type="date" data-booking-date value="${date}" aria-label="${__("Date")}"></div><div class="rms-res-list-tabs"><button type="button" data-booking-filter="active">${__("Upcoming & seated")}</button><button type="button" data-booking-filter="all">${__("All")}</button></div></div><div data-booking-list></div>`}],primary_action_label:__("New reservation"),primary_action:()=>this.reservationDialog(null,this.state.selected,reload)});
		dialog.$wrapper.addClass("rms-floor-service-dialog rms-reservation-dialog");
		const root=dialog.$wrapper;
		const render=()=>{
			const now=moment(frappe.datetime.system_datetime());
			root.find("[data-booking-day]").each((_,el)=>el.setAttribute("aria-pressed",moment().add(Number(el.dataset.bookingDay),"days").format("YYYY-MM-DD")===date));
			root.find("[data-booking-filter]").each((_,el)=>el.setAttribute("aria-pressed",el.dataset.bookingFilter===filter));
			root.find("[data-booking-list]").html(`<div class="rms-res-list">${rows.filter(row=>filter==="all"||["Reserved","Seated"].includes(row.status)).map(row=>{
				const table=this.state.tables.find(t=>t.name===row.dining_table),start=moment(row.starts_at),end=moment(row.ends_at),late=row.status==="Reserved"&&start.isBefore(now);
				const canSeat=row.status==="Reserved"&&now.isBefore(end)&&this.state.session?.status==="Open"&&this.state.permissions.can_checkout;
				const deposit=row.deposit||{};
				return `<article class="rms-res-list-card is-${row.status.toLowerCase().replaceAll(" ","-")}"><div class="rms-res-list-time"><b>${escTime(start)}</b><span>${escTime(end)}</span></div><div class="rms-res-list-info"><div><b dir="auto">${this.escape(row.guest_name)}</b><span class="rms-res-badge ${late?"is-late":""}">${late?__("Awaiting arrival"):__(row.status)}</span></div><p>${this.icon("table")}${this.escape(table?this.tableLabel(table):this.floorLabel(row.dining_table))}<span>·</span>${row.guests} ${__("guests")}<span>·</span><bdi>${this.escape(row.phone)}</bdi></p>${row.notes?`<small>${this.escape(row.notes)}</small>`:""}<div class="rms-res-deposit-info">${deposit.received?`${__("Deposit")}: <b>${this.currency(deposit.balance)}</b> ${deposit.applied?` · ${__("Applied")}: ${this.currency(deposit.applied)}`:""}${deposit.refunded?` · ${__("Refunded")}: ${this.currency(deposit.refunded)}`:""}`:__("No deposit")}</div></div><div class="rms-res-list-actions">${canSeat?`<button type="button" class="is-primary" data-booking-seat="${row.name}">${__("Seat guests")}</button>`:""}${row.status==="Reserved"?`<button type="button" data-booking-edit="${row.name}">${__("Edit")}</button><button type="button" data-booking-cancel="${row.name}">${__("Cancel")}</button>${late?`<button type="button" data-booking-no-show="${row.name}">${__("No Show")}</button>`:""}`:""}${Number(deposit.balance)>0&&row.status!=="Seated"&&this.state.permissions.can_approve_discount?`<button type="button" data-booking-refund="${row.name}">${__("Refund deposit")}</button>`:""}</div></article>`;
			}).join("")||`<div class="rms-res-empty">${this.icon("calendar")}<h3>${__("No reservations here yet")}</h3><p>${__("Create a booking with or without a deposit.")}</p></div>`}</div>`);
		};
		const escTime=time=>this.escape(time.format("h:mm A"));
		const reload=async()=>{const token=++request;try{const result=await this.call("rms.api.table_service.get_reservations",{store:this.state.store,date});if(token!==request)return;rows=result||[];render();}catch(error){this.showError(error);}};
		root.on("change","[data-booking-date]",event=>{date=event.target.value;reload();});
		root.on("click","[data-booking-day]",event=>{date=moment(frappe.datetime.system_datetime()).add(Number(event.currentTarget.dataset.bookingDay),"days").format("YYYY-MM-DD");root.find("[data-booking-date]").val(date);reload();});
		root.on("click","[data-booking-filter]",event=>{filter=event.currentTarget.dataset.bookingFilter;render();});
		root.on("click","[data-booking-edit]",event=>this.reservationDialog(rows.find(row=>row.name===event.currentTarget.dataset.bookingEdit),null,reload));
		root.on("click","[data-booking-seat]",event=>{const row=rows.find(row=>row.name===event.currentTarget.dataset.bookingSeat);if(row){dialog.hide();this.seatReservation(row);}});
		const cancel=(name,status)=>{const row=rows.find(row=>row.name===name);if(!row)return;frappe.confirm(`${status==="Cancelled"?__("Cancel this reservation?"):__("Mark this reservation as No Show?")}${Number(row.deposit?.balance)>0?`<br>${__("The unused deposit remains recorded until a manager explicitly refunds it.")}`:""}`,async()=>{try{await this.call("rms.api.table_service.set_reservation_status",{name,status,expected_modified:row.modified});await reload();await this.load(true);}catch(error){this.showError(error);}});};
		root.on("click","[data-booking-cancel]",event=>cancel(event.currentTarget.dataset.bookingCancel,"Cancelled"));
		root.on("click","[data-booking-no-show]",event=>cancel(event.currentTarget.dataset.bookingNoShow,"No Show"));
		root.on("click","[data-booking-refund]",event=>this.refundReservation(rows.find(row=>row.name===event.currentTarget.dataset.bookingRefund),reload));
		dialog.show();reload();return dialog;
	}

	refundReservation(row,onSaved) {
		if(!row)return;
		const methods=this.pos.state.payment_config||[],requestId=window.crypto.randomUUID();
		const dialog=new frappe.ui.Dialog({title:__("Refund reservation deposit"),fields:[{fieldtype:"HTML",fieldname:"summary",options:`<div class="rms-res-summary"><b>${this.escape(row.guest_name)}</b><span>${__("Unused deposit")}: ${this.currency(row.deposit.balance)}</span></div>`},{fieldtype:"Currency",fieldname:"amount",label:__("Refund amount"),default:row.deposit.balance,reqd:1},{fieldtype:"Select",fieldname:"mode_of_payment",label:__("Refund to"),options:methods.map(r=>r.mode_of_payment),reqd:1},{fieldtype:"Small Text",fieldname:"remarks",label:__("Reason"),reqd:1}],primary_action_label:__("Confirm refund"),primary_action:values=>this.dialogAction(dialog,async()=>{await this.call("rms.reservation_payments.transact",{reservation:row.name,kind:"Refund",...values,request_id:requestId});dialog.hide();await onSaved?.();})});
		dialog.$wrapper.addClass("rms-floor-service-dialog rms-reservation-dialog");dialog.show();
	}

	async seatReservation(reservation) {
		try {
			const tables=await this.call("rms.api.table_service.get_arrival_tables",{reservation:reservation.name});
			const available=tables.filter(row=>row.bookable&&!row.occupied);
			if(!available.length)return frappe.msgprint(__("No suitable table is free. Edit the reservation time or free a table first."));
			const original=available.find(row=>row.name===reservation.dining_table);
			if(original)return this.openTable(original.name,reservation,original);
			let selected=null;
			const dialog=new frappe.ui.Dialog({title:__("Choose a table for arrival"),fields:[{fieldtype:"HTML",fieldname:"tables",options:`<p>${__("The reserved table is busy. Seat these guests at another suitable table.")}</p><div class="rms-res-table-grid">${available.map(row=>`<button type="button" data-arrival-table="${this.escape(row.name)}">${this.tableArt(row)}<b>${this.escape(this.tableLabel(row))}</b><small>${row.capacity} ${__("seats")}</small></button>`).join("")}</div>`}],primary_action_label:__("Continue"),primary_action:()=>{if(selected){dialog.hide();this.openTable(selected,reservation,available.find(row=>row.name===selected));}}});
			dialog.$wrapper.addClass("rms-floor-service-dialog rms-reservation-dialog");dialog.$wrapper.on("click","[data-arrival-table]",event=>{selected=event.currentTarget.dataset.arrivalTable;dialog.$wrapper.find("[data-arrival-table]").each((_,el)=>el.setAttribute("aria-pressed",el.dataset.arrivalTable===selected));dialog.get_primary_btn().prop("disabled",false);});dialog.show();dialog.get_primary_btn().prop("disabled",true);
		}catch(error){this.showError(error);}
	}


	async launchPOS(context) {
		if (this.pos.state.session?.status !== "Open") return frappe.msgprint(__("Open your cashier session before creating a table order."));
		this.pos.pendingLaunchContext = context;
		await this.pos.applyLaunchContext();
	}

	async openOrder(name) { this.launchPOS({ store: this.state.store, order_name: name }); }

	async printCheck(name) {
		const popup = window.open("", "_blank");
		if (!popup) return frappe.msgprint(__("Allow pop-ups to print the check."));
		try {
			const html = await this.call("rms.api.table_service.print_table_check", { order_name: name });
			popup.document.open(); popup.document.write(html); popup.document.close();
			await this.load(true);
		} catch (error) { popup.close(); this.showError(error); }
	}

	async viewOrder(name) {
		try {
			const order = await this.call("get_open_order_overview", { order_name: name });
			const items = (order.items || []).map((row) => `<li><span>${this.escape(row.title)} × ${this.escape(row.qty)}</span><b>${this.currency(row.amount)}</b></li>`).join("");
			const dialog = new frappe.ui.Dialog({ title: `${__("Table check")}: ${this.escape(order.check_label || order.name)}`, size: "large", fields: [
				{ fieldtype: "HTML", fieldname: "order", options: `<div class="rms-table-overview"><p>${this.escape(order.status)} · ${this.escape(order.cashier || "")}</p><ul>${items}</ul><strong>${__("Total")}: ${this.currency(order.grand_total)}</strong></div>` },
			], primary_action_label: __("Close"), primary_action: () => dialog.hide() });
			dialog.$wrapper.addClass("rms-floor-service-dialog"); dialog.show();
		} catch (error) { this.showError(error); }
	}


	actionTableCard(table, label) {
		return `<div class="rms-table-action-caption">${label}</div><div class="rms-table-action-table">${this.tableArt(table)}<strong>${this.escape(this.tableLabel(table))}</strong><small>${this.escape(this.areaLabel(table))}</small></div>`;
	}

	async tableActionDialog({ mode, title, order, candidates }) {
		const sourceTable = this.state.tables.find(table => table.name === order.dining_table) || { name: order.dining_table };
		const isSplit = mode === "split", isMerge = mode === "merge";
		let selected = null, selectionRevision = 0, step = 1;
		const quantities = {};
		const items = (order.items || []).filter(row => row.sent_to_kitchen && Number(row.qty) > 0);
		const candidateTable = row => isMerge ? this.state.tables.find(table => table.name === row.dining_table) || { name: row.dining_table } : row;
		const html = `<div class="rms-table-action-progress" ${isSplit ? "" : "hidden"}><b data-step-number>1</b><span data-step-label>${__("Choose a table")}</span></div><div class="rms-table-action-flow"><section>${this.actionTableCard(sourceTable, isMerge ? __("Keep this table") : __("From table"))}</section><span class="rms-table-action-arrow">${this.icon(isMerge ? "merge" : isSplit ? "split" : "arrow")}</span><section data-action-destination><div class="rms-table-action-caption">${isMerge ? __("Add another check") : __("To table")}</div><div class="rms-table-action-placeholder">${this.icon("table")}<span>${__("Choose a table below")}</span></div></section></div>
			<section data-action-step="1"><div class="rms-table-action-picker-head"><strong>${isMerge ? __("Compatible checks") : __("Available tables")}</strong><label>${this.icon("search")}<input type="search" data-action-table-search placeholder="${__("Search tables")}" aria-label="${__("Search tables")}"></label></div>
			<div class="rms-table-action-choices" role="group" aria-label="${__("Destination table")}">${candidates.map((row, index) => {
				const table = candidateTable(row);
				return `<button type="button" data-action-table="${index}" aria-pressed="false" data-search="${this.escape([this.tableLabel(table), this.areaLabel(table), row.check_label || ""].join(" ").toLocaleLowerCase())}">${this.tableArt(table)}<strong>${this.escape(this.tableLabel(table))}</strong><small>${this.escape(this.areaLabel(table))}</small><span>${isMerge ? this.currency(row.grand_total) : `${Number(row.capacity)} ${__("seats")}`}</span></button>`;
			}).join("")}<p data-action-no-matches hidden>${__("No matching tables")}</p></div></section>
			${isSplit ? `<section data-action-step="2" hidden><div class="rms-table-split-head"><div><strong>${__("Items to move")}</strong><small>${__("Choose quantities for the other table. The remaining items stay here.")}</small></div><label>${__("Guests moving")}<input type="number" data-split-guests value="1" min="1" max="${Math.max(1, Number(order.guest_count || 2) - 1)}" step="1"></label></div><div class="rms-table-split-items">${items.map((row, index) => `<article data-split-row="${index}"><label><input type="checkbox" data-split-select="${index}"><span><strong>${this.escape(row.title)}</strong><small>${__("Available")}: ${row.qty}${row.notes ? ` · ${this.escape(row.notes)}` : ""}</small></span></label><div class="rms-table-split-stepper" dir="ltr"><button type="button" data-split-step="-1" data-index="${index}" aria-label="${__("Decrease quantity")}">−</button><input type="number" data-split-qty="${index}" value="0" min="0" max="${Number(row.qty)}" step="${row.must_be_whole_number ? 1 : .1}" aria-label="${__("Quantity")}"><button type="button" data-split-step="1" data-index="${index}" aria-label="${__("Increase quantity")}">+</button></div></article>`).join("")}</div></section>` : ""}
			<div class="rms-table-action-result" data-action-summary>${isMerge ? __("Both orders will become one check on this table.") : isSplit ? __("Select a table and the items to move.") : __("The whole order and its guests move together.")}</div><p class="rms-table-action-error" data-action-error role="alert" hidden></p>`;
		const dialog = new frappe.ui.Dialog({ title, size: "large", fields: [{ fieldtype: "HTML", fieldname: "action_ui", options: html }],
			primary_action_label: isMerge ? __("Merge into one check") : isSplit ? __("Next") : __("Move to selected table"),
			primary_action: () => {
				if (isSplit && step === 1) { if (selected) { step = 2; update(); } return; }
				return this.dialogAction(dialog, async () => {
				if (!selected) throw Error(__("Choose a destination table."));
				if (isSplit && !Object.values(quantities).some(qty => qty > 0)) throw Error(__("Choose items and quantities to move to the other table."));
				await this.pos.flushDraftSave();
				if (isMerge) await this.call("rms.api.table_service.merge_table_orders", { target_order: order.name, source_order: selected.name });
				else if (isSplit) await this.call("rms.api.table_service.split_table_order", { order_name: order.name, dining_table: selected.name,
					quantities: JSON.stringify(quantities), guests: Number(dialog.$wrapper.find("[data-split-guests]").val()), expected_modified: order.modified });
				else await this.call("transfer_order", { order_name: order.name, dining_table: selected.name });
				dialog.hide(); await this.load(true);
				if (!isMerge && !isSplit) this.selectTable(selected.name, false);
				if ([order.name, isMerge && selected.name].includes(this.pos.state.order_name)) await this.pos.syncCurrentOrder(null, true);
				frappe.show_alert({ message: isMerge ? __("Checks merged") : isSplit ? __("Selected items moved to the other table") : __("Order moved"), indicator: "green" });
			}); } });
		dialog.$wrapper.addClass("rms-floor-service-dialog rms-table-action-dialog");
		const root = dialog.$wrapper;
		if (isSplit) root.find(".modal-footer").prepend(`<button type="button" class="rms-res-secondary" data-split-back hidden>${__("Back")}</button>`);
		root.on("click", "[data-split-back]", () => { step = 1; update(); });
		root.find(".modal-footer").prepend(root.find("[data-action-summary]"));
		const update = () => {
			const moved = Object.values(quantities).reduce((sum, qty) => sum + qty, 0);
			const remaining = items.reduce((sum, row) => sum + Number(row.qty), 0) - moved;
			const guests = Number(root.find("[data-split-guests]").val());
			const valid = selected && (!isSplit || step === 1 || (moved > 0 && remaining > 0.000001 && Number.isInteger(guests) && guests >= 1 && guests <= Number(selected.capacity)));
			if (valid && !dialog.rmsSubmitting) dialog.enable_primary_action(); else dialog.disable_primary_action();
			dialog.get_primary_btn().prop("disabled", !valid || Boolean(dialog.rmsSubmitting));
			if (isSplit) {
				root.find("[data-action-step]").each((_, el) => { el.hidden = Number(el.dataset.actionStep) !== step; });
				root.find("[data-split-back]").prop("hidden", step !== 2);
				root.find("[data-step-number]").text(step);
				root.find("[data-step-label]").text(step === 1 ? __("Choose a table") : __("Choose items"));
				dialog.get_primary_btn().text(step === 1 ? __("Next") : __("Confirm"));
				root.find("[data-action-summary]").html(`<span>${__("Moving")}: <b dir="ltr">${Number(moved.toFixed(3))}</b></span><span>${__("Items remaining")}: <b dir="ltr">${Number(remaining.toFixed(3))}</b></span>`);
				root.find("[data-split-row]").each((_, el) => {
					const index = Number(el.dataset.splitRow), row = items[index], qty = quantities[row.order_item_name] || 0;
					el.classList.toggle("is-selected", qty > 0);
					$(el).find("[data-split-select]").prop("checked", qty > 0);
					$(el).find('[data-split-step="-1"]').prop("disabled", qty <= 0);
					$(el).find('[data-split-step="1"]').prop("disabled", qty >= Number(row.qty));
				});
			}
		};
		const setQty = (index, value) => {
			const row = items[index];
			let qty = Number(value); if (!Number.isFinite(qty)) qty = 0;
			qty = Math.max(0, Math.min(Number(row.qty), row.must_be_whole_number ? Math.round(qty) : Number(qty.toFixed(3))));
			if (qty) quantities[row.order_item_name] = qty; else delete quantities[row.order_item_name];
			root.find(`[data-split-qty="${index}"]`).val(qty); update();
		};
		root.on("click", "[data-action-table]", async event => {
			selected = candidates[Number(event.currentTarget.dataset.actionTable)];
			const revision = ++selectionRevision, table = candidateTable(selected);
			root.find("[data-action-table]").attr("aria-pressed", "false"); $(event.currentTarget).attr("aria-pressed", "true");
			root.find("[data-action-destination]").html(this.actionTableCard(table, isMerge ? __("Check to add") : __("To table")));
			if (isMerge) {
				root.find("[data-action-summary]").html(`<span>${__("One combined check")}</span><strong>${this.currency(Number(order.grand_total) + Number(selected.grand_total))}</strong>`);
				try {
					const detail = await this.call("rms.api.table_service.get_table_order", { order_name: selected.name });
					if (revision === selectionRevision) root.find("[data-action-destination]").append(`<p class="rms-table-action-order-preview">${(detail.items || []).filter(row => Number(row.qty) > 0).map(row => `<span>${this.escape(row.title)} <b dir="ltr">×${Number(row.qty)}</b></span>`).join("")}</p>`);
				} catch (error) { if (revision === selectionRevision) this.showError(error); }
			}
			update();
		});
		root.on("input", "[data-action-table-search]", event => {
			const query = event.target.value.trim().toLocaleLowerCase(); let visible = 0;
			root.find("[data-action-table]").each((_, el) => { el.hidden = !el.dataset.search.includes(query); if (!el.hidden) visible++; });
			root.find("[data-action-no-matches]").prop("hidden", Boolean(visible));
		});
		root.on("change", "[data-split-select]", event => setQty(Number(event.target.dataset.splitSelect), event.target.checked ? Math.min(1, Number(items[Number(event.target.dataset.splitSelect)].qty)) : 0));
		root.on("change", "[data-split-qty]", event => setQty(Number(event.target.dataset.splitQty), event.target.value));
		root.on("click", "[data-split-step]", event => {
			const index = Number(event.currentTarget.dataset.index), row = items[index];
			setQty(index, (quantities[row.order_item_name] || 0) + Number(event.currentTarget.dataset.splitStep) * (row.must_be_whole_number ? 1 : .1));
		});
		root.on("input change", "[data-split-guests]", update);
		dialog.rmsUpdate = update; dialog.show(); update();
		return dialog;
	}

	async transferOrder(name) {
		try {
			const order = await this.call("rms.api.table_service.get_table_order", { order_name: name });
			const candidates = (await this.call("rms.api.table_service.get_floor", { store: order.store }))
				.filter(row => this.isFreeTable(row) && row.name !== order.dining_table && Number(row.capacity) >= Number(order.guest_count || 0));
			if (!candidates.length) return frappe.msgprint(__("There are no available destination tables."));
			return this.tableActionDialog({ mode: "move", title: __("Move table"), order, candidates });
		} catch (error) { this.showError(error); }
	}

	async splitOrder(name) {
		try {
			const order = await this.call("rms.api.table_service.get_table_order", { order_name: name });
			if ((order.items || []).filter(row => Number(row.qty) > 0).length < 2) return;
			const candidates = (await this.call("rms.api.table_service.get_floor", { store: order.store }))
				.filter(row => this.isFreeTable(row) && row.name !== order.dining_table);
			if (!candidates.length) return frappe.msgprint(__("There are no available destination tables."));
			return this.tableActionDialog({ mode: "split", title: __("Split to another table"), order, candidates });
		} catch (error) { this.showError(error); }
	}

	async mergeOrder(name) {
		try {
			const order = await this.call("rms.api.table_service.get_table_order", { order_name: name });
			const rows = await this.call("rms.api.table_service.get_merge_candidates", { order_name: name });
			const candidates = rows.filter(row => row.name !== name && row.cashier_session === this.state.session?.name && row.dining_table && row.order_type === order.order_type && row.restaurant_brand === order.restaurant_brand);
			if (!candidates.length) return frappe.msgprint(__("No compatible open check is available to merge."));
			return this.tableActionDialog({ mode: "merge", title: __("Merge tables"), order, candidates });
		} catch (error) { this.showError(error); }
	}

	showError(error) {
		if (this.pos?.showError) return this.pos.showError(error);
		const raw = error?.message ?? error?.responseJSON?.message ?? error;
		const message = typeof raw === "string" ? raw : raw == null ? __("The operation could not be completed.") : JSON.stringify(raw);
		frappe.msgprint({ title: __("Table management"), message, indicator: "red" });
	}
};
