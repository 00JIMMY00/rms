/* RMS form navigation and dependent links. Native controls, saving and permissions stay authoritative. */
(() => {
  const guides = {
    "Selling Product": [
      "Product setup",
      "Start with the product identity, then configure prices, ingredients and availability.",
    ],
    Store: [
      "Store setup",
      "Choose the company first, assign one default brand, then configure taxes and cashier defaults.",
    ],
    "POS User": [
      "Cashier access",
      "Assign stores first. Choose what this person can see and do, then limit their scope if needed.",
    ],
    "Modifier Group": [
      "Modifier rules",
      "Set the minimum and maximum choices, then decide how this group appears in the cashier screen.",
    ],
    "Product Category": [
      "Organize your catalog",
      "Use a parent group for navigation and leaf categories for products. Defaults are inherited by products.",
    ],
    "Restaurant Brand": [
      "Brand setup",
      "Set the brand identity and rounding preference, then assign its menus.",
    ],
    "Store Menu": [
      "Build a menu",
      "Choose its brand, then add categories in the order you want customers and cashiers to see them.",
    ],
    "Dining Area": [
      "Dining layout",
      "Choose the store, then optionally limit this area to one of its brands.",
    ],
    "Dining Table": [
      "Table setup",
      "Choose the store and dining area, then set the table capacity.",
    ],
    "Preparation Area": [
      "Kitchen and preparation",
      "Choose the store and enable the kitchen display, printing, or both.",
    ],
    "Print Device": [
      "Printer connection",
      "Choose the printing method. Only the relevant connection settings are shown.",
    ],
    "Order Type": [
      "Order behavior",
      "Choose the information this order type needs, then map its accounts by company.",
    ],
    "Expense Category": [
      "Expense accounts",
      "Choose the company first. Available expense accounts and cost centers follow that company.",
    ],
    "POS Action Reason": [
      "Operational reasons",
      "Use clear reasons that cashiers can select for cancellations, returns, or both.",
    ],
    "Cashier Session": [
      "Cashier session",
      "Use the cashier screen to open and close sessions. This record shows balances and linked documents.",
    ],
    "POS Order": [
      "Order record",
      "Review items, totals and payments here. Manage the order from the cashier screen.",
    ],
    "POS Return": [
      "Return review",
      "Review returned quantities, refund payments and the manager approval history.",
    ],
    "Shift Expense": [
      "Expense review",
      "Review the expense, its resolved accounts and approval status. Cashiers create requests from POS.",
    ],
    "Kitchen Ticket": [
      "Kitchen progress",
      "Track preparation and cancellation notices. Kitchen actions are performed from the kitchen display.",
    ],
    "Waste Entry": [
      "Stock write-off",
      "Choose the product, quantity and warehouse. The stock movement remains linked to this record.",
    ],
    "Approval Challenge": [
      "Operation approval",
      "Review the requested operation and approval status. Codes and authorization are handled by the existing approval flow.",
    ],
    "Print Dispatch Job": [
      "Print delivery",
      "Review the printer, source document and delivery result. Existing retry actions remain available.",
    ],
    "RMS Sync Event": [
      "Synchronization log",
      "Read-only technical evidence of a captured change. Expand the payload only when investigating an issue.",
    ],
    "RMS Sync Settings": [
      "Synchronization settings",
      "Choose whether changes are captured. The schema version is managed by the system.",
    ],
  };
  const operational = new Set([
    "Cashier Session",
    "POS Order",
    "POS Return",
    "Shift Expense",
    "Kitchen Ticket",
    "Approval Challenge",
    "Print Dispatch Job",
    "RMS Sync Event",
  ]);
  const query = (doctype, stores, extra = {}) => ({
    query: "rms.form_queries.scoped_link",
    filters: { stores: [...new Set(stores.filter(Boolean))], ...extra },
  });
  const rowDoc = (cdt, cdn) => window.locals?.[cdt]?.[cdn] || {};
  function setupQueries(frm) {
    const single = (name, getter) => {
      if (frm.fields_dict[name]) frm.set_query(name, getter);
    };
    const child = (table, name, getter) => {
      if (frm.fields_dict[table]) frm.set_query(name, table, getter);
    };
    const dt = frm.doctype;
    if (dt === "Dining Area")
      single("restaurant_brand", () =>
        query("Restaurant Brand", [frm.doc.store])
      );
    if (dt === "POS User") {
      const stores = () => (frm.doc.stores || []).map((row) => row.store);
      child("stores", "pos_profile", (_, cdt, cdn) =>
        query("POS Profile", [rowDoc(cdt, cdn).store])
      );
      child("allowed_brands", "restaurant_brand", () =>
        query("Restaurant Brand", stores())
      );
      child("allowed_order_types", "order_type", () =>
        query("Order Type", stores())
      );
      child("allowed_preparation_areas", "preparation_area", () =>
        query("Preparation Area", stores(), { kds_only: 1 })
      );
    }
    if (dt === "Selling Product") {
      for (const [name, target] of [
        ["restaurant_brand", "Restaurant Brand"],
        ["order_type", "Order Type"],
      ]) {
        child("selling_prices", name, (_, cdt, cdn) => {
          const store = rowDoc(cdt, cdn).store;
          return store ? query(target, [store]) : { filters: { enabled: 1 } };
        });
      }
    }
  }
  const element = (value) => value?.[0] || value;
  const visible = (control) =>
    !!control &&
    !control.df?.hidden &&
    control.get_status?.() !== "None" &&
    !!element(control.wrapper)?.getClientRects().length;
  function missingFields(frm) {
    return (frm.fields || []).filter((control) => {
      const df = control.df || {};
      if (!df.reqd || df.read_only || !visible(control)) return false;
      const value = frm.doc[df.fieldname];
      return (
        value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      );
    });
  }
  function jump(section, control) {
    section?.collapse?.(false);
    const wrapper = element(section?.wrapper || control?.wrapper);
    wrapper?.scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
    control?.$input?.trigger?.("focus");
  }
  function render(frm) {
    const wrapper = element(frm.wrapper);
    const layout = element(frm.layout?.wrapper);
    if (!wrapper || !layout || !guides[frm.doctype]) return;
    wrapper.classList.add("rms-custom-form");
    let ui = frm.__rmsExperience;
    if (!ui || !ui.root.isConnected) {
      const root = document.createElement("section");
      root.className = "rms-form-guide";
      const copy = document.createElement("div");
      const eyebrow = document.createElement("span");
      eyebrow.className = "rms-form-eyebrow";
      const title = document.createElement("h2"),
        detail = document.createElement("p");
      copy.append(eyebrow, title, detail);
      const progress = document.createElement("button");
      progress.type = "button";
      progress.className = "rms-form-completion";
      const nav = document.createElement("nav");
      nav.className = "rms-form-sections";
      root.append(copy, progress, nav);
      layout.prepend(root);
      ui = frm.__rmsExperience = {
        root,
        title,
        detail,
        eyebrow,
        progress,
        nav,
      };
      let pending;
      for (const event of ["input", "change"])
        layout.addEventListener(event, () => {
          clearTimeout(pending);
          pending = setTimeout(() => schedule(frm), 100);
        });
      progress.addEventListener("click", () => {
        const first = missingFields(frm)[0];
        if (first) jump(first.section, first);
      });
    }
    const text = (node, value) => {
      if (node.textContent !== value) node.textContent = value;
    };
    const [title, detail] = guides[frm.doctype];
    text(ui.title, __(title));
    text(ui.detail, __(detail));
    text(
      ui.eyebrow,
      operational.has(frm.doctype) ? __("RMS / Operations") : __("RMS / Setup")
    );
    const missing = missingFields(frm);
    text(
      ui.progress,
      missing.length
        ? __("{0} required fields remaining", [missing.length])
        : __("Basic required fields complete")
    );
    ui.progress.disabled = !missing.length;
    ui.progress.hidden = operational.has(frm.doctype) && !missing.length;
    ui.progress.classList.toggle("is-complete", !missing.length);
    const sections = (frm.layout.sections || []).filter(
      (section) =>
        section.df?.label &&
        !section.df.hidden &&
        !element(section.wrapper)?.classList.contains("hide-control") &&
        element(section.wrapper)?.getClientRects().length
    );
    const signature = JSON.stringify(
      sections.map((section) => [section.df.fieldname, __(section.df.label)])
    );
    if (ui.signature !== signature) {
      ui.signature = signature;
      ui.nav.replaceChildren();
      sections.forEach((section, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rms-form-section-link";
        const number = document.createElement("span");
        number.textContent = String(index + 1).padStart(2, "0");
        number.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = __(section.df.label);
        button.append(number, label);
        button.addEventListener("click", () => {
          jump(section);
          ui.nav
            .querySelectorAll("button")
            .forEach((node) => node.removeAttribute("aria-current"));
          button.setAttribute("aria-current", "location");
        });
        ui.nav.append(button);
      });
    }
    ui.nav.hidden = sections.length < 2;
    ui.nav.setAttribute("aria-label", __("Form sections"));
  }
  const schedule = (frm) => {
    if (frm.__rmsFormRefreshPending) return;
    frm.__rmsFormRefreshPending = true;
    requestAnimationFrame(() => {
      frm.__rmsFormRefreshPending = false;
      render(frm);
    });
  };
  window.RMSFormExperience = {
    guides,
    setupQueries,
    missingFields,
    render,
    query,
  };
  for (const dt of Object.keys(guides)) {
    const handlers = {
      setup: setupQueries,
      refresh: schedule,
      onload_post_render: schedule,
      after_save: schedule,
    };
    for (const name of [
      "has_options",
      "is_modifier",
      "can_be_sold_separately",
      "with_recipe",
      "maintain_stock",
      "allow_collapse",
      "allow_multiple_selections",
      "has_printer",
      "has_kds",
      "print_method",
      "is_group",
      "can_access_kitchen",
      "can_void_items",
      "can_request_returns",
      "can_apply_manual_discount",
      "status",
      "company",
      "store",
      "default_store",
      "title",
      "user",
      "expense_category",
      "selling_price",
      "option_attribute",
    ])
      handlers[name] = schedule;
    if (dt === "Modifier Group")
      handlers.allow_collapse = async (frm) => {
        if (!frm.doc.allow_collapse && frm.doc.collapsed_by_default)
          await frm.set_value("collapsed_by_default", 0);
        schedule(frm);
      };
    if (dt === "Selling Product")
      handlers.with_recipe = async (frm) => {
        if (
          !frm.doc.with_recipe &&
          ((frm.doc.recipe || []).length ||
            (frm.doc.additional_recipe || []).length)
        ) {
          await frm.set_value("with_recipe", 1);
          frappe.msgprint(
            __(
              "Remove the recipe rows before turning off the recipe. Your ingredients have been kept."
            )
          );
        }
        schedule(frm);
      };
    frappe.ui.form.on(dt, handlers);
  }
})();
