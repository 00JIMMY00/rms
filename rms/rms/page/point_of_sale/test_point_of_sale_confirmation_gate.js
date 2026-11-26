const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const messages = [], writes = [];
const context = {
 frappe: { pages: { 'point-of-sale': {} }, msgprint: message => messages.push(message) },
 window: { open: () => { throw new Error('Do not open a print window for pending items'); } },
 __: value => value, clearTimeout,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'point_of_sale.js'), 'utf8') + '\nglobalThis.POS=RMSPointOfSale;', context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../public/js/table_management.js'), 'utf8'), context);
function register() {
 const pos = Object.create(context.POS.prototype);
 pos.state = { order_name: 'ORDER', order_status: 'Confirmed', session: {name:'SHIFT'}, permissions:{can_checkout:true}, order_types:[],
  cart: [{qty:20, price:445, sent_to_kitchen:1}, {qty:1, price:10, sent_to_kitchen:0}] };
 pos.call = async method => { writes.push(method); throw Error('Unexpected action: '+method); };
 return pos;
}
async function run() {
 const pos = register();
 assert.ok(pos.hasUnconfirmedItems());
 await pos.printOpenOrderCheck(); await pos.submitPayment(); await pos.cancelConfirmedItems(); pos.showPaymentScreen();
 assert.equal(messages.length,4);
 assert.deepEqual(writes,[],'pending items cannot reach payment, print or void actions');
 pos.state.cart[1].qty=0;
 assert.equal(pos.hasUnconfirmedItems(),false);
 pos.state.cart[1].qty=2; pos.state.cart[1].cancelled_qty=2;
 assert.equal(pos.hasUnconfirmedItems(),false,'fully removed quantities must not leave an action lock');
 // Removing the last addition must finish saving before payment can be shown.
 pos.state.cart.pop();
 let finishSave;
 pos.flushDraftSave=()=>new Promise(resolve=>{finishSave=resolve;});
 pos.ensureCurrentOrderActive=async()=>true;
 pos.persistDraft=()=>{throw Error('Do not reconfirm the sent items');};
 pos.showPaymentScreen=()=>{pos.paymentShown=true;};
 const payment=pos.checkout();
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(pos.paymentShown,undefined);
 finishSave();await payment;
 assert.ok(pos.paymentShown);
 // Both new and mixed saved checks expose only confirmation on the floor.
 const floor=Object.create(context.window.RMSTableManagement.prototype);
 floor.state={tables:[{name:"FREE",capacity:4}],session:{name:'SHIFT',status:'Open'},permissions:{can_checkout:true,can_edit_open_orders:true,can_transfer_tables:true,can_split_orders:true,can_merge_orders:true,can_reprint_receipts:true,can_cancel_orders:true}};
 floor.escape=String;
 const order={name:'ORDER',status:'Confirmed',cashier_session:'SHIFT',dining_table:'T1',items:[{qty:20,sent_to_kitchen:1},{qty:1,sent_to_kitchen:0}],pending_item_count:1,merge_candidates:[{name:'OTHER'}]};
 let html=floor.renderActions(order);
 assert.equal((html.match(/<button/g)||[]).length,1);
 assert.match(html,/data-confirm-order/);
 assert.doesNotMatch(html,/data-(pay-order|print-check|merge-order|split-order|transfer-order|cancel-order|view-order|reserve-table)/);
 for(const resolve of [()=>{order.items[1].sent_to_kitchen=1;},()=>{order.items.pop();}]) {
  resolve();order.pending_item_count=0;
  html=floor.renderActions(order);
  assert.equal(html.includes('data-split-order'),order.items.length>1);
  for(const action of ['pay-order','print-check','merge-order',...(order.items.length>1?['split-order']:[]),'transfer-order','void-order']) assert.ok(html.includes('data-'+action),action+' returns after resolution');
 }
 console.log('PASS: pending-item action gates, saved-removal ordering, and automatic floor action restoration.');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
