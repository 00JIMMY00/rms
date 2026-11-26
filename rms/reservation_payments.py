"""Booking deposits: a liability receipt, explicit refund, then a non-cash POS tender.

Receipt/refund journals affect the receiving till. Redemption debits the liability
through ERPNext's ordinary invoice payment ledger, without receiving cash twice.
"""
import math
from contextvars import ContextVar

import frappe
from frappe import _
from frappe.utils import flt, nowdate, get_datetime, now_datetime

DEPOSIT_METHOD = "RMS Reservation Deposit"
writing_payment = ContextVar("rms_writing_reservation_payment", default=False)


def payment_summary(reservation):
    rows = frappe.get_all("Reservation Payment", filters={"reservation": reservation},
                          fields=["kind", "amount", "mode_of_payment", "creation", "journal_entry", "pos_invoice"])
    totals = {kind: flt(sum(flt(r.amount) for r in rows if r.kind == kind), 2)
              for kind in ("Receive", "Refund", "Apply")}
    return {"received": totals["Receive"], "refunded": totals["Refund"], "applied": totals["Apply"],
            "balance": flt(totals["Receive"] - totals["Refund"] - totals["Apply"], 2), "transactions": rows}


def ensure_accounts(company):
    """Create one dedicated liability and general tender per company, never a cash tender."""
    # Serialise the shared account/MOP setup across different reservations.
    frappe.db.sql("select name from tabCompany where name=%s for update", company)
    account = frappe.db.get_value("Account", {"company": company, "account_name": "RMS Reservation Deposits"}, "name")
    currency = frappe.db.get_value("Company", company, "default_currency")
    if not account:
        parent = frappe.db.get_value("Account", {"company": company, "account_name": "Current Liabilities", "is_group": 1}, "name")
        parent = parent or frappe.db.get_value("Account", {"company": company, "root_type": "Liability", "is_group": 1, "parent_account": ["is", "not set"]}, "name")
        if not parent:
            frappe.throw(_("Set up the Company's liability accounts before collecting a deposit."))
        account = frappe.get_doc({"doctype": "Account", "company": company, "account_name": "RMS Reservation Deposits",
                                 "parent_account": parent, "account_currency": currency, "is_group": 0}).insert(ignore_permissions=True).name
    info = frappe.db.get_value("Account", account, ["root_type", "is_group", "account_currency", "disabled"], as_dict=True)
    if info.root_type != "Liability" or info.is_group or info.disabled or info.account_currency != currency:
        frappe.throw(_("The reservation deposit account must be an active liability in the Company currency."))
    mop = frappe.get_doc("Mode of Payment", DEPOSIT_METHOD) if frappe.db.exists("Mode of Payment", DEPOSIT_METHOD) else frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": DEPOSIT_METHOD, "type": "General", "enabled": 1})
    if mop.type != "General" or not mop.enabled:
        frappe.throw(_("The reservation deposit payment method must be enabled with type General."))
    mapping = next((r for r in mop.accounts if r.company == company), None)
    if mapping and mapping.default_account != account:
        frappe.throw(_("The reservation deposit payment method has an incorrect liability account."))
    if not mapping:
        mop.append("accounts", {"company": company, "default_account": account})
        mop.save(ignore_permissions=True)
    return account


def record(**values):
    token = writing_payment.set(True)
    try:
        return frappe.get_doc({"doctype": "Reservation Payment", **values}).insert(ignore_permissions=True)
    finally:
        writing_payment.reset(token)


@frappe.whitelist(methods=["POST"])
def transact(reservation, kind, amount, mode_of_payment, request_id, remarks=None):
    from rms.api import pos
    from rms.expenses import _get_expense_payment_account
    pos.require_pos_action("can_checkout")
    booking = frappe.get_doc("Table Reservation", reservation, for_update=True)
    pos.assert_store_access(booking.store)
    if not isinstance(request_id, str) or not 12 <= len(request_id) <= 100:
        frappe.throw(_("A payment request ID is required."))
    previous = frappe.db.get_value("Reservation Payment", {"request_id": request_id}, ["name", "reservation", "kind", "amount", "mode_of_payment"], as_dict=True)
    if previous:
        if previous.reservation != reservation or previous.kind != kind or flt(previous.amount, 2) != flt(amount, 2) or previous.mode_of_payment != mode_of_payment:
            frappe.throw(_("This payment request was already used for a different transaction."))
        return {"name": previous.name, **payment_summary(reservation)}
    if kind not in ("Receive", "Refund") or not math.isfinite(flt(amount)) or flt(amount, 2) <= 0:
        frappe.throw(_("Enter a valid deposit or refund amount."))
    amount = flt(amount, 2)
    session = pos.get_user_session(booking.store)
    if not session or session.user != frappe.session.user:
        frappe.throw(_("Open your cashier session before handling a reservation deposit."))
    session = frappe.get_doc("Cashier Session", session.name, for_update=True)
    if session.status != "Open" or mode_of_payment == DEPOSIT_METHOD or mode_of_payment not in {r.mode_of_payment for r in session.payments}:
        frappe.throw(_("Choose a payment method from your open cashier session."))
    if kind == "Receive" and (booking.status != "Reserved" or get_datetime(booking.ends_at) <= now_datetime()):
        frappe.throw(_("Collect deposits only for upcoming reservations."))
    if kind == "Refund":
        if not (set(frappe.get_roles()) & {"POS Manager", "System Manager"}):
            frappe.throw(_("A POS Manager must authorize a reservation refund."), frappe.PermissionError)
        if booking.status == "Seated":
            frappe.throw(_("Finish or close the table order before refunding its remaining deposit."))
        if amount > payment_summary(reservation)["balance"] + .001:
            frappe.throw(_("The refund exceeds the unused reservation deposit."))
        if not (remarks or "").strip():
            frappe.throw(_("Enter a reason for this refund."))
    company = frappe.db.get_value("Store", booking.store, "company")
    currency = frappe.db.get_value("Company", company, "default_currency")
    payment_account = _get_expense_payment_account(company, mode_of_payment)
    actor = frappe.session.user
    try:
        frappe.set_user("Administrator")
        liability = ensure_accounts(company)
        debit, credit = (payment_account, liability) if kind == "Receive" else (liability, payment_account)
        journal = frappe.get_doc({"doctype": "Journal Entry", "voucher_type": "Journal Entry", "company": company,
                                 "posting_date": nowdate(), "user_remark": f"{kind} reservation deposit · {booking.name} · {booking.guest_name} · {actor}",
                                 "accounts": [{"account": debit, "debit_in_account_currency": amount},
                                              {"account": credit, "credit_in_account_currency": amount}]}).insert(ignore_permissions=True)
        journal.submit()
    finally:
        frappe.set_user(actor)
    event = record(reservation=reservation, store=booking.store, company=company, currency=currency, cashier_session=session.name,
                   kind=kind, amount=amount, mode_of_payment=mode_of_payment, journal_entry=journal.name, request_id=request_id, remarks=remarks)
    booking.add_comment("Info", _("{0} deposit: {1} {2}. Reference: {3}.").format(kind, amount, currency, event.name))
    session.reload()
    session.save(ignore_permissions=True)
    return {"name": event.name, **payment_summary(reservation)}


def order_deposits(order_name, lock=False):
    # All linked bookings follow a merged check; split checks do not duplicate credit.
    names = frappe.get_all("Table Reservation", filters={"pos_order": order_name, "status": "Seated"}, pluck="name", order_by="name")
    bookings = [frappe.get_doc("Table Reservation", name, for_update=lock) for name in names]
    return [(b, payment_summary(b.name)["balance"]) for b in bookings]


@frappe.whitelist()
def get_order_deposit(order_name):
    from rms.api import pos
    pos.require_pos_action("can_checkout")
    order = frappe.get_doc("POS Order", order_name)
    pos.assert_store_access(order.store)
    pos.require_order_scope(order)
    return {"balance": flt(sum(amount for _, amount in order_deposits(order_name)), 2)}


def apply_deposit(bookings, amount, order, invoice, session):
    remaining = flt(amount, 2)
    company = invoice.company
    currency = frappe.db.get_value("Company", company, "default_currency")
    for booking, balance in bookings:
        used = min(remaining, balance)
        if used <= .001:
            continue
        record(reservation=booking.name, store=order.store, company=company, currency=currency,
               cashier_session=session.name, kind="Apply", amount=used, mode_of_payment=DEPOSIT_METHOD,
               pos_order=order.name, pos_invoice=invoice.name, request_id=f"apply:{frappe.generate_hash(length=32)}")
        remaining = flt(remaining - used, 2)
    if remaining > .001:
        frappe.throw(_("The reservation deposit changed. Refresh payment and retry."))


def applied_to_order(order_name):
    return flt(sum(r.amount for r in frappe.get_all("Reservation Payment", filters={"pos_order": order_name, "kind": "Apply"}, fields=["amount"])), 2)


def permission_query(user=None):
    from rms.table_service import reservation_permission_query
    return reservation_permission_query(user).replace("`tabTable Reservation`", "`tabReservation Payment`")
