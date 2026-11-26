import React,{useState} from 'react';
import {Button} from '@openai/apps-sdk-ui/components/Button';
import {Badge} from '@openai/apps-sdk-ui/components/Badge';
import {Alert} from '@openai/apps-sdk-ui/components/Alert';
import {Input} from '@openai/apps-sdk-ui/components/Input';
import {Textarea} from '@openai/apps-sdk-ui/components/Textarea';
import {Checkbox} from '@openai/apps-sdk-ui/components/Checkbox';
import {Switch} from '@openai/apps-sdk-ui/components/Switch';
import {Select} from '@openai/apps-sdk-ui/components/Select';
import {RadioGroup} from '@openai/apps-sdk-ui/components/RadioGroup';
import {SegmentedControl} from '@openai/apps-sdk-ui/components/SegmentedControl';
import {Slider} from '@openai/apps-sdk-ui/components/Slider';
import {Markdown} from '@openai/apps-sdk-ui/components/Markdown';
import {splitUiContent,safeWidgetAction,type UiSpec} from '../utils/openaiUi';
import {isUnsafeChatInteractiveAction,parseChatInteractiveToken,normalizeAiInteractiveMarkup} from '../utils/svlLogic';
import {parseFollowUpToken} from '../utils/chatInteractiveTokens';

type Action=(action:string,label?:string)=>void|Promise<void>;
function legacyAllowed(action:string){
  if(isUnsafeChatInteractiveAction(action))return false;
  return safeWidgetAction(action)||/^(?:tab|nav|open|goto):[a-z0-9_-]+$/i.test(action)||/^action:(?:sync|report|avatars|ollama|vision|duplex|scan|antivirus)$/i.test(action)||/^send:\/(?:status|mcp (?:status|test|tools|telemetry)|jedi (?:status|ping))$/i.test(action);
}
function ActionButton({label,action,onAction,legacy=false}:{label:string;action:string;onAction?:Action;legacy?:boolean}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const enabled=Boolean(onAction)&&(legacy?legacyAllowed(action):safeWidgetAction(action));
  return <span className="inline-flex flex-col gap-1"><Button color="secondary" variant="outline" size="md" disabled={!enabled||busy} loading={busy} onClick={async()=>{
    if(!enabled||busy)return;setBusy(true);setError('');
    try{await onAction?.(action,label)}catch(e){setError(e instanceof Error?e.message:'Błąd akcji')}finally{setBusy(false)}
  }}>{label}</Button>{error&&<span role="alert">{error}</span>}</span>
}
function Md({text}:{text:string}){return <Markdown includeMath breakNewLines skipHtml urlTransform={url=>/^(https?:\/\/|#)/i.test(url)?url:''}>{text}</Markdown>}
function LegacyMarkdown({text,onAction}:{text:string;onAction?:Action}){
  // Read old stored messages and command receipts without mounting the retired widget system.
  const buttons:{label:string;action:string}[]=[];let fence=false;
  const clean=text.split('\n').map(line=>{
    if(/^\s*\x60\x60\x60/.test(line)){fence=!fence;return line}
    if(fence||!onAction)return line;
    const follow=parseFollowUpToken(line.trim());if(follow){buttons.push({label:follow.prompt,action:follow.action});return ''}
    return normalizeAiInteractiveMarkup(line).replace(/\[(?:btn|button|action|przycisk):[^\]\n]+\]/gi,raw=>{
      const parsed=parseChatInteractiveToken(raw);if(!parsed)return raw;
      buttons.push(parsed);return parsed.label.replace(/\|/g,' ');
    }).replace(/\[(?:card|metric|karta|badge|znacznik|progress|postep|postęp|kpi|metrics|metryka):([^\]\n]+)\]/gi,(_m,v)=>v.replace(/\|/g,' · '));
  }).join('\n');
  return <><Md text={clean}/>{buttons.length>0&&<div className="my-2 flex flex-wrap gap-2">{buttons.slice(0,24).map((b,i)=><ActionButton key={i} {...b} legacy onAction={onAction}/>)}</div>}</>
}
function Chart({chart}:{chart:NonNullable<UiSpec['chart']>}){
  const low=Math.min(0,...chart.values),high=Math.max(0,...chart.values),range=high-low||1;
  const y=(v:number)=>110-(v-low)/range*90;
  return <figure className="space-y-2"><svg role="img" aria-label="Wykres danych" viewBox="0 0 320 130" width="100%" style={{maxHeight:230}}><path d={'M 10 '+y(0)+' H 310'} stroke="currentColor" opacity=".4"/>{chart.type==='line'?<><polyline fill="none" stroke="currentColor" strokeWidth="2" points={chart.values.map((v,i)=>(10+i*300/Math.max(1,chart.values.length-1))+','+y(v)).join(' ')}/>{chart.values.map((v,i)=><circle key={i} cx={10+i*300/Math.max(1,chart.values.length-1)} cy={y(v)} r="3" fill="currentColor"><title>{chart.labels[i]}: {v}</title></circle>)}</>:chart.values.map((v,i)=><rect key={i} x={10+i*300/chart.values.length+2} y={Math.min(y(v),y(0))} width={Math.max(1,300/chart.values.length-4)} height={Math.max(1,Math.abs(y(v)-y(0)))} rx="2" fill="currentColor" opacity=".75"><title>{chart.labels[i]}: {v}</title></rect>)}</svg><figcaption className="flex flex-wrap gap-2">{chart.labels.map((l,i)=><Badge key={i}>{l}: {chart.values[i]}</Badge>)}</figcaption></figure>
}
function Widget({spec,onAction}:{spec:UiSpec;onAction?:Action}){
  const [values,setValues]=useState<Record<string,string|number|boolean>>(()=>Object.fromEntries(spec.fields.map(f=>[f.name,f.value])));
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const set=(name:string,v:string|number|boolean)=>setValues(prev=>({...prev,[name]:v}));
  return <section className="my-3 border border-current/20 rounded-2xl p-3 sm:p-4 space-y-3" data-svl-openai-widget="true">
    {spec.title&&<h3 className="font-semibold">{spec.title}</h3>}{spec.text&&<Md text={spec.text}/>}
    {spec.badges.length>0&&<div className="flex flex-wrap gap-2">{spec.badges.map((b,i)=><Badge key={i} color={b.color}>{b.label}</Badge>)}</div>}
    {spec.chart&&<Chart chart={spec.chart}/>}
    {spec.table&&<div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>{spec.table.headers.map((h,i)=><th key={i} className="p-2 border-b border-current/20">{h}</th>)}</tr></thead><tbody>{spec.table.rows.map((r,i)=><tr key={i}>{r.map((cell,j)=><td key={j} className="p-2 border-b border-current/10">{cell}</td>)}</tr>)}</tbody></table></div>}
    {spec.fields.length>0&&<form className="space-y-3" onSubmit={async e=>{e.preventDefault();if(!onAction||busy)return;setBusy(true);setError('');try{await onAction('text:'+JSON.stringify({title:spec.title,answers:values},null,2),spec.submitLabel)}catch(err){setError(err instanceof Error?err.message:'Błąd formularza')}finally{setBusy(false)}}}>
    {spec.fields.map(f=><div key={f.name} className="space-y-1">
      {['checkbox','switch'].includes(f.type)?null:<div className="font-medium">{f.label}</div>}
      {f.type==='checkbox'?<Checkbox label={f.label} checked={Boolean(values[f.name])} onCheckedChange={v=>set(f.name,v)}/>:f.type==='switch'?<Switch label={f.label} checked={Boolean(values[f.name])} onCheckedChange={v=>set(f.name,v)}/>:f.type==='slider'?<Slider label={f.label} min={f.min} max={f.max} step={f.step} value={Number(values[f.name])} onChange={v=>set(f.name,v)}/>:f.type==='select'?<Select options={f.options} value={String(values[f.name])} onChange={v=>set(f.name,v.value)}/>:f.type==='radio'?<RadioGroup aria-label={f.label} direction="col" value={String(values[f.name])} onChange={v=>set(f.name,v)}>{f.options.map((o,i)=><RadioGroup.Item key={i} value={o.value}>{o.label}</RadioGroup.Item>)}</RadioGroup>:f.type==='segmented'?<SegmentedControl aria-label={f.label} value={String(values[f.name])} onChange={v=>set(f.name,v)}>{f.options.map((o,i)=><SegmentedControl.Option key={i} value={o.value}>{o.label}</SegmentedControl.Option>)}</SegmentedControl>:f.type==='textarea'?<Textarea aria-label={f.label} value={String(values[f.name])} onChange={e=>set(f.name,e.target.value)} maxLength={1000} autoResize/>:<Input aria-label={f.label} type={f.type==='date'?'date':f.type==='number'?'number':'text'} value={String(values[f.name])} onChange={e=>set(f.name,e.target.value)} maxLength={1000}/>}
    </div>)}
    <Button type="submit" color="primary" disabled={!onAction||busy} loading={busy}>{spec.submitLabel} do pola czatu</Button>
    {error&&<Alert color="danger" description={error}/>}
    </form>}
    {spec.buttons.length>0&&<div className="flex flex-wrap gap-2">{spec.buttons.map((b,i)=><ActionButton key={i} {...b} onAction={onAction}/>)}</div>}
  </section>
}
export function renderFormattedContent(content:string,onAction?:Action):React.ReactNode{
  const text=String(content||''); if(!onAction)return <Md text={text}/>;
  return splitUiContent(text).map((part,i)=>'widget'in part?<Widget key={i} spec={part.widget} onAction={onAction}/>:<LegacyMarkdown key={i} text={part.text} onAction={onAction}/>);
}
export function renderFormattedLine(line:string,keyPrefix:string,onAction?:Action):React.ReactNode{return <React.Fragment key={keyPrefix}>{renderFormattedContent(line,onAction)}</React.Fragment>}
