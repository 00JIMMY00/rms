const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {}, __: value => value, frappe: {pages:{"point-of-sale":{}},msgprint() {}, utils:{escape_html:String}} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'point_of_sale.js'), 'utf8')+'\nglobalThis.POS=RMSPointOfSale;',context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../public/js/table_management.js'), 'utf8'), context);
async function run() {
 const floor = Object.create(context.window.RMSTableManagement.prototype);
 const order = {name:'ORDER', store:'STORE', status:'Confirmed', cashier_session:'SHIFT', dining_table:'T1', guest_count:3, restaurant_brand:'BRAND', order_type:'DINE', modified:'revision', items:[{order_item_name:'A',qty:1,sent_to_kitchen:true},{order_item_name:'B',qty:1,sent_to_kitchen:true}]};
 const tables = [
  {name:'T1',occupied:true,capacity:4}, {name:'FREE',capacity:4,service_status:'available'},
  {name:'BUSY',capacity:4,occupied:true}, {name:'RESERVED',capacity:4,reserved:true},
  {name:'SMALL',capacity:1}, {name:'STALE',capacity:4,open_orders:[{order:'OTHER'}]},
 ];
 floor.state = {session:{name:'SHIFT',status:'Open'},permissions:{can_checkout:true},tables};
 const dialogs=[];
 floor.tableActionDialog = async config => {dialogs.push(config);};
 floor.call = async method => method.endsWith('get_floor') ? tables : method.endsWith('get_merge_candidates') ? [
  {...order,name:'OTHER',dining_table:'BUSY'}, {...order,name:'OTHER_SHIFT',cashier_session:'ELSEWHERE'},
  {...order,name:'OTHER_BRAND',restaurant_brand:'ELSEWHERE'}, {...order,name:'TAKEAWAY',dining_table:null},
 ] : order;
 await floor.transferOrder('ORDER');
 assert.equal(dialogs.at(-1).mode,'move');
 assert.deepEqual(Array.from(dialogs.at(-1).candidates,row=>row.name),['FREE']);
 const originalItems=order.items;order.items=[originalItems[0]];await floor.splitOrder('ORDER');assert.equal(dialogs.length,1,'single-line split is hidden even when quantity can be divided');order.items=originalItems;await floor.splitOrder('ORDER');
 assert.equal(dialogs.at(-1).mode,'split','table split must not launch the guest-bill payment screen');
 assert.deepEqual(Array.from(dialogs.at(-1).candidates,row=>row.name),['FREE','SMALL']);
 await floor.mergeOrder('ORDER');
 assert.deepEqual(Array.from(dialogs.at(-1).candidates,row=>row.name),['OTHER']);
 floor.escape=String;floor.currency=String;
 floor.pos=Object.create(context.POS.prototype);floor.pos.escape=String;floor.pos.currency=String;
 order.items=[{order_item_name:'SENT',title:'Prepared',qty:5,ordered_qty:20,cancelled_qty:15,amount:500,sent_to_kitchen:true},{order_item_name:'PENDING',title:'Tea',qty:2,amount:20,sent_to_kitchen:false}];
 let html=floor.renderOrder(order);
 assert.match(html,/data-floor-remove="PENDING"/);
 assert.match(html,/data-floor-quantity="PENDING"/);
 assert.doesNotMatch(html,/data-floor-remove="SENT"/);
 floor.state.itemTab='confirmed';html=floor.renderOrder(order);
 assert.match(html,/<b>5<\/b>/,'overview quantities are already net of earlier voids');
 assert.doesNotMatch(html,/data-floor-quantity/);
 // A slow action cannot be submitted again by changing selection or double clicking.
 let disabled=false, submissions=0, release;
 const dialog={get_primary_btn:()=>({prop(key,value){if(arguments.length===1)return disabled;disabled=value;}})};
 const pending=new Promise(resolve=>{release=resolve;});
 const first=floor.dialogAction(dialog,async()=>{submissions++;await pending;});
 disabled=false; // simulate another UI update during the request
 await floor.dialogAction(dialog,async()=>{submissions++;});
 assert.equal(submissions,1);release();await first;assert.equal(dialog.rmsSubmitting,false);
 console.log('PASS: available-table filtering, table split instead of guest payment, compatible merges, editable pending rows, net confirmed quantities and duplicate-submit protection.');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
