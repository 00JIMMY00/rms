const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const storage = new Map(), alerts = [];
const context = {
 frappe: { pages: { 'point-of-sale': {} }, session: { user: 'cashier@example.com' }, show_alert: value => alerts.push(value) },
 sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
 __: value => value, clearTimeout,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'point_of_sale.js'), 'utf8') + '\nglobalThis.POS = RMSPointOfSale;', context);
function register() {
 const pos = Object.create(context.POS.prototype);
 pos.state = { store: 'STORE-1', session: { name: 'SESSION-1' }, order_name: null, permissions: { can_checkout: true },
  order_types: [{ name: 'صالة', require_table: true }, { name: 'تيك أواي' }, { name: 'توصيل' }], cart: [] };
 pos.page = { main: { find: () => ({ prop() { return this; }, val(value) { pos.selectedType = value; return this; } }) } };
 pos.renderCart = pos.renderFields = pos.updateOrderTypeFields = () => {};
 pos.loadCatalog = async () => { pos.catalogLoads = (pos.catalogLoads || 0) + 1; };
 return pos;
}
async function run() {
 const first = register();
 assert.equal(first.defaultOrderType(), 'تيك أواي');
 first.state.order_name = 'ORDER-9'; first.state.order_type = 'صالة';
 first.rememberCurrentScreen('payment');
 const restored = register();
 restored.pendingResumeContext = restored.readResumeContext();
 const calls = [];
 restored.call = async method => {
  calls.push(method);
  return method === 'get_order_state' ? { status: 'Confirmed' } : { name: 'ORDER-9', store: 'STORE-1', status: 'Confirmed', order_type: 'صالة' };
 };
 restored.loadOrder = async order => {
  restored.state.order_name = order.name; restored.state.order_type = order.order_type;
  restored.rememberCurrentScreen('sale');
 };
 restored.showPaymentScreen = () => { restored.paymentShown = true; restored.rememberCurrentScreen('payment'); };
 await restored.restoreCurrentOrder();
 assert.equal(restored.state.order_name, 'ORDER-9');
 assert.equal(restored.state.order_type, 'صالة', 'resuming an order must keep its saved type');
 assert.ok(restored.paymentShown, 'reload restores the payment screen');
 assert.deepEqual(calls, ['get_order'], 'reload must read the existing order without creating a new one');
 // A new sale clears the saved ID, resets to takeaway and reloads its prices.
 restored.resetSale();
 assert.equal(restored.state.order_name, null);
 assert.equal(restored.state.order_type, 'تيك أواي');
 assert.equal(restored.selectedType, 'تيك أواي');
 assert.equal(restored.catalogLoads, 1);
 assert.equal(restored.readResumeContext(), null);
 // English variants and unavailable takeaway respect the allowed type list.
 restored.state.order_types = [{ name: 'Dine In' }, { name: 'TAKE-AWAY' }];
 assert.equal(restored.defaultOrderType(), 'TAKE-AWAY');
 restored.state.order_types = [{ name: 'Delivery' }];
 assert.equal(restored.defaultOrderType(), 'Delivery');
 // Bootstrap selects takeaway before browsing, but keeps an explicit loaded type.
 const boot = register();
 boot.call = async () => ({ store: { name: 'STORE-1' }, session: { name: 'SESSION-1' },
  brands: [{ name: 'BRAND-1' }], order_types: [{ name: 'صالة' }, { name: 'تيك أواي' }] });
 boot.render = boot.loadContextDetails = boot.applyLaunchContext = () => {};
 boot.showError = error => { throw error; };
 await boot.loadBootstrap('STORE-1');
 assert.equal(boot.state.order_type, 'تيك أواي');
 boot.state.order_type = 'صالة';
 await boot.loadBootstrap('STORE-1');
 assert.equal(boot.state.order_type, 'صالة');
 for (const status of ['Paid', 'Cancelled']) {
  const closed = register();
  closed.pendingResumeContext = { store: 'STORE-1', session: 'SESSION-1', order_name: 'ORDER-9' };
  closed.call = async method => { assert.equal(method, 'get_order'); return { status }; };
  closed.loadOrder = () => { throw new Error('A closed order must not be reopened'); };
  await closed.restoreCurrentOrder();
  assert.equal(closed.state.order_name, null);
 }
 assert.equal(alerts.length, 2);
 const sessionChanged = register();
 sessionChanged.pendingResumeContext = { store: 'STORE-1', session: 'OLD-SESSION', order_name: 'ORDER-9' };
 sessionChanged.call = () => { throw new Error('Do not resume another session'); };
 await sessionChanged.restoreCurrentOrder();
 // The floor replaces only the content: keep the cashier, cart and route intact.
 const floor = register();
 let saved = false;
 floor.flushDraftSave = async () => { saved = true; };
 const existingCart = [{ title: 'Pending takeaway item' }];
 floor.state.cart = existingCart;
 floor.state.order_type = 'تيك أواي';
 floor.tableFloor = { state: {}, load: async () => { assert.ok(saved); floor.floorLoaded = true; } };
 floor.ensureTableFloor = async () => {};
 context.frappe.set_route = () => { throw new Error('Switching floor content must not navigate away'); };
 await floor.showTableMap();
 assert.equal(floor.contentView, 'tables');
 assert.ok(floor.floorLoaded);
 assert.equal(floor.state.cart, existingCart);
 assert.equal(floor.state.order_type, 'تيك أواي', 'the locked floor label cannot change a saved takeaway draft');
 floor.setContentView('menu');
 assert.equal(floor.contentView, 'menu');
 assert.equal(floor.state.cart, existingCart);
 // The floor can be opened without an open till; opening one remains the native header action.
 floor.state.session = null;
 await floor.showTableMap();
 assert.equal(floor.contentView, 'tables');
 // A pending floor refresh must not drop a quick Menu -> Tables switch.
 let finishFloorLoad;
 const floorLoad = new Promise(resolve => { finishFloorLoad = resolve; });
 floor.tableFloor.load = () => floorLoad;
 const refreshing = floor.showTableMap();
 await new Promise(resolve => setTimeout(resolve, 0));
 floor.setContentView('menu');
 const reopened = floor.showTableMap();
 await new Promise(resolve => setTimeout(resolve, 0));
 assert.equal(floor.contentView, 'tables');
 finishFloorLoad();
 await Promise.all([refreshing, reopened]);
 // Returning from an available table starts a separate check, preserving the saved one.
 const nextTable = register();
 nextTable.state.session.status = 'Open';
 nextTable.state.order_name = 'EXISTING-CHECK';
 nextTable.state.cart = [{ title: 'Existing items' }];
 nextTable.pendingLaunchContext = { store: 'STORE-1', dining_area: 'AREA-2', dining_table: 'TABLE-2' };
 let finishSave;
 nextTable.flushDraftSave = () => new Promise(resolve => { finishSave = resolve; });
 const launch = nextTable.applyLaunchContext();
 assert.equal(nextTable.state.order_name, 'EXISTING-CHECK', 'never reset a check while its save is pending');
 finishSave(); await launch;
 assert.equal(nextTable.state.order_name, null);
 assert.equal(nextTable.state.cart.length, 0);
 assert.equal(nextTable.state.order_type, 'صالة');
 assert.equal(nextTable.state.dining_area, 'AREA-2');
 assert.equal(nextTable.state.dining_table, 'TABLE-2');
 // A failed draft save keeps the check and pending table selection intact.
 const failedLaunch = register();
 failedLaunch.state.session.status = 'Open'; failedLaunch.state.order_name = 'UNSAVED-CHECK';
 failedLaunch.pendingLaunchContext = { store: 'STORE-1', dining_table: 'TABLE-3' };
 failedLaunch.flushDraftSave = async () => { throw new Error('Save failed'); };
 await assert.rejects(failedLaunch.applyLaunchContext(), /Save failed/);
 assert.equal(failedLaunch.state.order_name, 'UNSAVED-CHECK');
 assert.equal(failedLaunch.pendingLaunchContext.dining_table, 'TABLE-3');
 // Table actions restore the menu before opening the payment split screen.
 const splitLaunch = register();
 splitLaunch.state.session.status = 'Open';
 splitLaunch.pendingLaunchContext = { store: 'STORE-1', order_name: 'TABLE-CHECK', action: 'split' };
 splitLaunch.flushDraftSave = async () => {};
 splitLaunch.call = async () => ({ name: 'TABLE-CHECK', status: 'Confirmed' });
 splitLaunch.loadOrder = async order => { splitLaunch.state.order_name = order.name; splitLaunch.state.order_status = order.status; };
 splitLaunch.checkout = async () => { splitLaunch.currentOrderScreen = 'payment'; };
 splitLaunch.openPaymentSplitDialog = () => { splitLaunch.splitOpened = true; };
 await splitLaunch.applyLaunchContext();
 assert.equal(splitLaunch.state.order_name, 'TABLE-CHECK');
 assert.equal(splitLaunch.splitOpened, true);
 // Removing the last draft item must persist the empty table, rather than revive it on refresh.
 const emptied = register();
 Object.assign(emptied.state, { order_name: 'EMPTY-TABLE', order_status: 'Open', dining_table: 'T1', brand: 'BRAND', order_type: 'صالة' });
 emptied.saveQueue = Promise.resolve();
 emptied.watchCurrentOrder = () => {};
 emptied.ensureCurrentOrderActive = async () => true;
 let savedItems;
 emptied.call = async (method, args) => {
  assert.equal(method, 'save_order'); savedItems = JSON.parse(args.order_data).items;
  return { name: 'EMPTY-TABLE', status: 'Open' };
 };
 await emptied.persistDraft();
 assert.equal(savedItems.length, 0);
 emptied.state.order_status = 'Confirmed';
 assert.equal(emptied.canSaveEmptyTable(), false, 'confirmed food cannot disappear through an empty draft save');
 // Bookmarks belong to the signed-in user, as well as the browser tab.
 first.rememberCurrentScreen('sale');
 context.frappe.session.user = 'another-cashier@example.com';
 assert.equal(register().readResumeContext(), null);
 console.log('PASS: takeaway defaults, new-sale reset, same-order/screen reload, closed-order checks, session and user isolation.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
