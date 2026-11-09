const vm=require('node:vm');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/monitor.js'),'utf8').replace(/^import .*;$/gm,'');
function element(){return {style:{},classList:{add(){},toggle(){}},append(){},textContent:'',title:''};}
const context=vm.createContext({app:{registerExtension(){}},api:{},document:{createElement:element},console,Map,Set,Number,Math,Date,JSON});
vm.runInContext(source,context);
vm.runInContext(`
body=document.createElement('div');
update('ram','RAM','green',60,'%',{used:40,total:64});
update('vram:0','VRAM','blue',33,'%',{used:8,total:24});
update('disk:/','Disk','purple',80,'%',{used:800,total:1000});
update('vram:0','VRAM','blue',20,'%',{used:5,total:24});
`,context);
assert.equal(vm.runInContext("peaks.get('vram:0').used",context),8);
assert.equal(vm.runInContext("peaks.get('ram').used",context),40);
assert.equal(vm.runInContext("peaks.get('disk:/').used",context),800);
vm.runInContext("update('vram:0','VRAM','blue',null)",context);
assert.equal(vm.runInContext("cards.get('vram:0').value.textContent",context),'—');
assert.equal(vm.runInContext("cards.get('vram:0').fill.style.transform",context),'scaleX(0)');
vm.runInContext("update('vram:0','VRAM','blue',50,'%',{used:12,total:24})",context);
assert.equal(vm.runInContext("cards.get('vram:0').value.textContent",context),'50%');
assert.equal(vm.runInContext("peaks.get('vram:0').used",context),12);
console.log('Frontend unit checks passed: isolated peaks, unavailable state, recovery.');
