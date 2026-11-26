// Data-only protocol: never evaluates JSX, HTML, JavaScript or shell commands.
export const OPENAI_UI_CAPABILITY = 'Optional interactive UI: append a fenced svl-ui JSON block, only if useful. Object keys: title, text, fields:[{type:"input|textarea|number|date|select|radio|segmented|checkbox|switch|slider",name,label,value,options:[{label,value}],min,max,step}], buttons:[{label,action:"send:ordinary question" or "text:draft" or "copy:text"}], badges:[{label,color:"secondary|success|warning|danger|info"}], table:{headers:[],rows:[[]]}, chart:{type:"bar|line",labels:[],values:[]}, submitLabel. No UI required; normal Markdown is supported.';
export type UiField = {type:string;name:string;label:string;value:string|number|boolean;options:{label:string;value:string}[];min:number;max:number;step:number};
export type UiSpec = {title:string;text:string;fields:UiField[];buttons:{label:string;action:string}[];badges:{label:string;color:'secondary'|'success'|'warning'|'danger'|'info'}[];table?:{headers:string[];rows:string[][]};chart?:{type:'bar'|'line';labels:string[];values:number[]};submitLabel:string};
const str=(v:unknown,max=400)=>typeof v==='string'?v.slice(0,max):typeof v==='number'||typeof v==='boolean'?String(v):'';
const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const arr=(v:unknown,max:number):unknown[]=>Array.isArray(v)?v.slice(0,max):[];
const num=(v:unknown,d:number)=>typeof v==='number'&&Number.isFinite(v)?Math.max(-1e9,Math.min(1e9,v)):d;
export function safeWidgetAction(action:string):boolean {
  if(!/^(?:send|text|copy):/i.test(action)||action.length>2000)return false;
  const payload=action.slice(action.indexOf(':')+1).trim();
  return Boolean(payload)&&(!/^send:/i.test(action)||!/^[/!#]|^(?:run|exec|root|ssh|sudo|bash|sh):/i.test(payload));
}
export function parseUiSpec(input:string):UiSpec|null {
  if(input.length>24000)return null;
  try {
    const x=JSON.parse(input); if(!obj(x))return null;
    const seen=new Set<string>();
    const fields=arr(x.fields,16).flatMap(v=>{
      if(!obj(v)||!['input','textarea','number','date','select','radio','segmented','checkbox','switch','slider'].includes(v.type)||typeof v.name!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(v.name)||seen.has(v.name))return [];
      seen.add(v.name);
      const options=arr(v.options,20).flatMap(o=>obj(o)&&str(o.value,120)?[{label:str(o.label,120)||str(o.value,120),value:str(o.value,120)}]:[]);
      const min=num(v.min,0), max=Math.max(min+0.01,num(v.max,100)), step=Math.max(0.01,Math.min(max-min,num(v.step,1)));
      const value=v.type==='slider'?Math.max(min,Math.min(max,num(v.value,min))):['checkbox','switch'].includes(v.type)?v.value===true:['select','radio','segmented'].includes(v.type)?options.find(o=>o.value===v.value)?.value||options[0]?.value||'':str(v.value,1000);
      return [{type:v.type,name:v.name,label:str(v.label,120)||v.name,value,options,min,max,step}];
    });
    const buttons=arr(x.buttons,12).flatMap(v=>obj(v)&&str(v.label,120)&&safeWidgetAction(str(v.action,2000))?[{label:str(v.label,120),action:str(v.action,2000)}]:[]);
    const colors=['secondary','success','warning','danger','info'] as const;
    const badges=arr(x.badges,12).flatMap(v=>obj(v)&&str(v.label,120)?[{label:str(v.label,120),color:colors.find(c=>c===v.color)||'secondary' as const}]:[]);
    const headers=obj(x.table)?arr(x.table.headers,10).map(v=>str(v,120)):[];
    const table=headers.length?{headers,rows:arr(x.table.rows,40).filter(Array.isArray).map(row=>headers.map((_,i)=>str(row[i],300)))}:undefined;
    const labels=obj(x.chart)?arr(x.chart.labels,30).map(v=>str(v,60)):[];
    const values=obj(x.chart)?arr(x.chart.values,30).map(v=>typeof v==='number'&&Number.isFinite(v)?v:NaN):[];
    const chart=labels.length&&labels.length===values.length&&values.every(Number.isFinite)?{type:x.chart.type==='line'?'line' as const:'bar' as const,labels,values}:undefined;
    const spec={title:str(x.title,160),text:str(x.text,4000),fields,buttons,badges,table,chart,submitLabel:str(x.submitLabel,80)||'Wyślij odpowiedzi'};
    return spec.title||spec.text||fields.length||buttons.length||badges.length||table||chart?spec:null;
  }catch{return null}
}
export function splitUiContent(content:string):Array<{text:string}|{widget:UiSpec}> {
  const parts:Array<{text:string}|{widget:UiSpec}>=[];
  const lines=content.split('\n');let text:string[]=[],fence=false;
  const flush=()=>{if(text.length){parts.push({text:text.join('\n')});text=[]}};
  for(let i=0;i<lines.length;i++){
    if(!fence&&/^\s*\x60\x60\x60svl-ui\s*$/.test(lines[i])){
      let end=i+1;while(end<lines.length&&!/^\s*\x60\x60\x60\s*$/.test(lines[end]))end++;
      if(end<lines.length){const widget=parseUiSpec(lines.slice(i+1,end).join('\n'));if(widget){flush();parts.push({widget});i=end;continue}}
    }
    if(/^\s*\x60\x60\x60/.test(lines[i]))fence=!fence;
    text.push(lines[i]);
  }
  flush();return parts;
}
