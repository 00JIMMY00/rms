const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const label={},toggle={setAttribute(){}},select={},list={children:[]};
const picker={querySelector:s=>({'[data-order-type-toggle]':toggle,'[data-order-type-list]':list,'[data-role="order-type-label"]':label,'[data-select="order_type"]':select}[s]),classList:{toggle(){}}};
const context={frappe:{pages:{'point-of-sale':{}}},document:{activeElement:null},__:value=>value,sessionStorage:{removeItem(){},setItem(){}}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'point_of_sale.js'),'utf8')+'\nglobalThis.POS=RMSPointOfSale;',context);
function register(){
 const pos=Object.create(context.POS.prototype);
 pos.state={store:'STORE',brand:'BRAND',order_types:[{name:'TAKEAWAY'},{name:'DINE',require_table:true},{name:'DELIVERY'}],order_type:'DINE',cart:[],order_name:null};
 pos.page={main:{0:{querySelector:()=>picker}}};pos.escape=String;pos.setOrderTypePickerOpen=()=>{};
 pos.watchCurrentOrder=()=>{};pos.updateContentView=()=>pos.renderOrderTypePicker();pos.updateOrderTypeFields=()=>pos.renderOrderTypePicker();
 pos.showTableMap=async options=>{pos.floorOptions=options;pos.setContentView('tables');};pos.loadTables=async()=>{};pos.loadCatalog=()=>{};
 return pos;
}
(async()=>{
 const pos=register();await pos.onOrderTypeChanged();assert.equal(pos.contentView,'tables');assert.equal(pos.floorOptions.fromOrderType,true);pos.renderOrderTypePicker();assert.equal(toggle.disabled,false,'the type picker remains usable on an empty floor');assert.equal(select.disabled,false);
 pos.state.order_type='TAKEAWAY';await pos.onOrderTypeChanged();assert.equal(pos.contentView,'menu');assert.equal(label.textContent,'TAKEAWAY');
 pos.state.order_type='DINE';await pos.onOrderTypeChanged();pos.state.order_type='DELIVERY';await pos.onOrderTypeChanged();assert.equal(pos.contentView,'menu');assert.equal(label.textContent,'DELIVERY');
 for(const change of [{cart:[{qty:1,sent_to_kitchen:false}]},{cart:[{qty:1,sent_to_kitchen:true}]},{order_name:'EMPTY-OPEN-TABLE'}]){
  const locked=register();Object.assign(locked.state,change);const cart=locked.state.cart;
  locked.renderOrderTypePicker();assert.equal(toggle.disabled,true);assert.equal(select.disabled,true);
  locked.showTableMap=()=>{throw Error('Do not change the type of a started order');};await locked.onOrderTypeChanged();assert.equal(locked.state.cart,cart);
 }
 // A late floor import must not reopen Tables after the cashier selects Takeaway.
 const delayed=register();delete delayed.showTableMap;let finish;
 delayed.flushDraftSave=async()=>{};delayed.ensureTableFloor=()=>new Promise(resolve=>{finish=resolve;});delayed.tableFloor={load:()=>{throw Error('Do not display the superseded floor');}};
 const opening=delayed.showTableMap({fromOrderType:true});for(let i=0;!finish&&i<5;i++)await Promise.resolve();
 delayed.state.order_type='TAKEAWAY';delayed.setContentView('menu');finish();await opening;assert.equal(delayed.contentView,'menu');assert.equal(delayed.openingTableView,false);
 console.log('PASS: Dine In opens Tables, Takeaway/Delivery return immediately, pending items lock type selection, and slow imports cannot undo a later choice.');
})().catch(error=>{console.error(error);process.exitCode=1;});
