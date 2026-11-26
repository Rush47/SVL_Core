import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiSpec,splitUiContent,safeWidgetAction} from './openaiUi';
test('widgets validate and reject shell and unknown action payloads',()=>{
 const s=parseUiSpec(JSON.stringify({title:'Test',buttons:[{label:'OK',action:'send:hello'},{label:'No',action:'send:/exec ls'}],fields:[{type:'slider',name:'x',value:999,min:0,max:10},{type:'script',name:'no'}]}));
 assert.equal(s?.buttons.length,1);assert.equal(s?.fields.length,1);assert.equal(s?.fields[0].value,10);
 assert.equal(safeWidgetAction('action:root'),false);
});
test('normal text, malformed widget and code examples remain unchanged',()=>{
 const f=String.fromCharCode(96).repeat(3);
 assert.deepEqual(splitUiContent('hello'),[{text:'hello'}]);
 assert.equal(splitUiContent(f+'svl-ui\n{}\n'+f).length,1);
 const p=splitUiContent('hello\n'+f+'svl-ui\n{"title":"Test"}\n'+f+'\nbye');
 assert.equal(p.length,3);assert.ok('widget' in p[1]);
});
