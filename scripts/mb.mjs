#!/usr/bin/env node
// MelonBuild AST query tool: read the AST in small, targeted slices instead of loading it whole.
// Zero dependencies. Node >= 18.
import {readFileSync,readdirSync,statSync,renameSync,existsSync,writeFileSync} from 'node:fs';
import {join,basename,extname} from 'node:path';

const USAGE=`mb.mjs <command> <ast.json> [args]

  outline  <ast> [--section <id>]      units, state groups, components, connectors
  tokens   <ast>                       colors / type / radius / spacing / shadow usage
  show     <ast> <id|Cn|path> [--depth N]   compact subtree + resolved styles
  diff     <ast> <idA> <idB>           what changes from A to B (state merging)
  texts    <ast> [id]                  all text content (deduped)
  check    <ast> <dir...> [--unit id]  texts / images missing from generated code
  assets   <ast> [--apply]             rename hashed image files after their Figma layers

path = <id or template>/<childIndex>/... e.g. 12:34/0/2`;

const [cmd,file,...rest]=process.argv.slice(2);
if(!cmd||!file||cmd==='-h'||cmd==='--help'){console.log(USAGE);process.exit(cmd?0:1);}
const ast=JSON.parse(readFileSync(file,'utf8'));
const T=ast.templates||{},G=ast.globalStyles||{};
const opt=(name,def)=>{const i=rest.indexOf(name);if(i<0)return def;const v=rest[i+1];rest.splice(i,2);return v;};

// ---------- basics ----------
const isRef=n=>n&&typeof n.t==='string';
const kids=n=>Array.isArray(n?.children)?n.children:[];
const STYLE_ATTRS=['layout','fills','fontStyle','strokes','effects'];
const short=(s,n)=>{s=String(s).replace(/\s+/g,' ');return s.length>n?s.slice(0,n-1)+'…':s;};
const val=v=>{
  if(v&&typeof v==='object'){
    if(typeof v.$param==='string')return '{'+v.$param+'}';
    if('x' in v&&'y' in v&&Object.keys(v).length===2)return v.x+','+v.y;
    return JSON.stringify(v);
  }
  if(typeof v==='string'){
    if(/[\\/]/.test(v)&&/\.(svg|png|jpe?g|webp|gif)$/i.test(v))v=basename(v);
    return /^[^\s"=]+$/.test(v)?v:JSON.stringify(v);
  }
  return String(v);
};
const resolved=new Map();
function style(key){
  if(resolved.has(key))return resolved.get(key);
  let v=G[key];
  if(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.extends==='string'){
    const {extends:ext,...own}=v;let base={};
    for(const b of ext.split(',').map(s=>s.trim()).filter(Boolean)){const bv=style(b);if(bv&&typeof bv==='object')base={...base,...bv};}
    v={...base,...own};
  }
  resolved.set(key,v);return v;
}
const imgName=s=>{const m=String(s).match(/url\(([^)]+)\)/);return basename((m?m[1]:String(s)).replace(/["']/g,''));};

// walk every concrete node; refs are visited as refs, template bodies are walked separately
function walk(list,fn,depth=0,parent=null){for(const n of list){if(fn(n,depth,parent)===false)continue;walk(kids(n),fn,depth+1,n);}}
const bodies=()=>Object.entries(T).map(([name,t])=>[name,t.body]);
function count(n){if(!n)return 0;if(isRef(n))return expandedSize(n.t)+kids(n).reduce((s,c)=>s+count(c),0);return 1+kids(n).reduce((s,c)=>s+count(c),0);}
const sizeMemo=new Map();
function expandedSize(name){if(sizeMemo.has(name))return sizeMemo.get(name);sizeMemo.set(name,0);const s=count(T[name]?.body);sizeMemo.set(name,s);return s;}

// index page-tree ids
const byId=new Map();
walk(ast.nodes,n=>{if(n.id!==undefined&&!byId.has(String(n.id)))byId.set(String(n.id),n);});
for(const [,b] of bodies())walk([b],n=>{if(n.id!==undefined&&!byId.has(String(n.id)))byId.set(String(n.id),n);});
function locate(spec){
  const [head,...steps]=spec.split('/');
  let n=byId.get(head)??byId.get(head.replace('-',':'))??(T[head]?{...T[head].body,__template:head}:null);
  if(!n)throw new Error('not found: '+head);
  for(const s of steps){
    const list=isRef(n)&&!kids(n).length?[T[n.t]?.body]:kids(n);
    n=list[Number(s)];if(!n)throw new Error('bad path step '+s+' in '+spec);
  }
  return n;
}

// ---------- show ----------
function attrLine(n){
  const parts=[];
  for(const [k,v] of Object.entries(n)){
    if(['tag','t','id','name','children','text','args','__template'].includes(k))continue;
    if(k==='width'&&'height' in n){parts.push(val(v)+'x'+val(n.height));continue;}
    if(k==='height'&&'width' in n)continue;
    parts.push(k+'='+val(v));
  }
  return parts.join(' ');
}
function show(root,maxDepth){
  const lines=[],usedStyles=new Set(),usedTemplates=new Set();
  const note=v=>{if(typeof v==='string'&&v in G)usedStyles.add(v);};
  (function rec(n,d,path){
    const pad='  '.repeat(d);
    if(isRef(n)&&/^T\d/.test(n.t)&&!kids(n).length&&T[n.t]?.body&&!T[n.t].params){
      // tiny compression templates: inline them instead of making the reader look them up
      return rec({...T[n.t].body,...(n.id!==undefined?{id:n.id}:{})},d,path);
    }
    if(isRef(n)){
      usedTemplates.add(n.t);
      const args=Object.entries(n.args||{}).map(([k,v])=>{note(v);return k+'='+val(v);}).join(' ');
      lines.push(pad+'<'+n.t+(n.id!==undefined?' #'+n.id:'')+(args?' '+args:'')+(kids(n).length?'>':' />')+'  ['+path+']');
      if(kids(n).length&&d<maxDepth)kids(n).forEach((c,i)=>rec(c,d+1,path+'/'+i));
      return;
    }
    for(const a of STYLE_ATTRS)note(n[a]);
    for(const v of Object.values(n))note(v);
    const head=(n.tag||'?')+(n.id!==undefined?' #'+n.id:'')+(n.name&&!/^(Frame|Group|Rectangle|Vector|Ellipse|Line)\s?\d*$/.test(n.name)?' "'+short(n.name,40)+'"':'');
    const text=n.text!==undefined?'  ⟨'+(typeof n.text==='object'?val(n.text):short(n.text,120))+'⟩':'';
    const a=attrLine(n);
    lines.push(pad+head+(a?' '+a:'')+text);
    const c=kids(n);
    if(!c.length)return;
    if(d>=maxDepth){lines.push(pad+'  … '+c.length+' children / '+c.reduce((s,x)=>s+count(x),0)+' nodes  → show '+path+' ');return;}
    c.forEach((x,i)=>rec(x,d+1,path+'/'+i));
  })(root,0,root.__template||String(root.id??root.t??'?'));
  // template header when showing a template
  if(root.__template){
    const t=T[root.__template];
    const meta=['uses='+(t.uses??'?'),'nodes='+expandedSize(root.__template)];
    if(t.params)meta.push('params '+JSON.stringify(t.params));
    if(t.variants)meta.push('variants '+JSON.stringify(t.variants));
    for(const v of [...Object.values(t.params||{}),...Object.values(t.variants||{}).flatMap(Object.values)])note(v);
    lines.unshift('template '+root.__template+' '+meta.join(' '));
  }
  if(isRef(root))lines.push('  (instance of '+root.t+': show '+root.t+' for its body; only args/slots differ per instance)');
  console.log(lines.join('\n'));
  if(usedTemplates.size){
    console.log('\nrefs: '+[...usedTemplates].map(t=>t+'(uses='+(T[t]?.uses??'?')+',nodes='+expandedSize(t)+(T[t]?.params?',params='+Object.keys(T[t].params).join('|'):'')+(T[t]?.variants?',variants='+Object.keys(T[t].variants).join('|'):'')+')').join(' '));
  }
  if(usedStyles.size){
    console.log('\nstyles:');
    for(const k of [...usedStyles].sort())console.log(k+' '+JSON.stringify(style(k)));
  }
}

// ---------- units & similarity ----------
// address of a node: its id when it has one, else nearest ancestor id + child indexes
const addr=new Map();
(function rec(list,base){list.forEach((n,i)=>{const a=n.id!==undefined?String(n.id):base+'/'+i;addr.set(n,a);if(!isRef(n))rec(kids(n),a);});})(ast.nodes,'');
const A=n=>addr.get(n)||String(n.id??'?');
function units(){
  const out=[];
  (function rec(list,group){
    for(const n of list){
      if(!isRef(n)&&(n.tag==='SECTION'||n.tag==='CANVAS')){out.push({section:n,group});rec(kids(n),n);continue;}
      out.push({unit:n,group});
    }
  })(ast.nodes,null);
  return out;
}
const normName=s=>String(s||'').replace(/[\d\s_\-]+/g,'').toLowerCase().slice(0,24);
function bag(n,depth=0,b=new Map()){
  if(!n||depth>5)return b;
  const key=depth+':'+(isRef(n)?n.t:n.tag+':'+normName(n.name));
  b.set(key,(b.get(key)||0)+1);
  const c=isRef(n)?kids(n):kids(n);
  for(const x of c)bag(x,depth+1,b);
  return b;
}
function jaccard(a,b){let i=0,u=0;const keys=new Set([...a.keys(),...b.keys()]);for(const k of keys){const x=a.get(k)||0,y=b.get(k)||0;i+=Math.min(x,y);u+=Math.max(x,y);}return u?i/u:0;}
const dim=n=>isRef(n)?(T[n.t]?.body||{}):n;
function texts(n,acc=[],env={}){
  if(!n)return acc;
  if(isRef(n)){
    const t=T[n.t];const e={...(t?.params||{}),...(t?.variants?.[n.args?.variant]||{}),...(n.args||{})};
    for(const k in e){const v=e[k];if(v&&typeof v==='object'&&v.$param)e[k]=env[v.$param];}
    texts(t?.body,acc,e);for(const s of kids(n))kids(s).forEach(c=>texts(c,acc,env));return acc;
  }
  if(n.text!==undefined){const v=typeof n.text==='object'&&n.text?.$param?env[n.text.$param]:n.text;if(typeof v==='string'&&v.trim())acc.push(v.trim());}
  for(const c of kids(n))texts(c,acc,env);
  return acc;
}
// expand a ref one level for similarity purposes (shell template + slot contents)
const flatRef=n=>isRef(n)?{tag:'REF',name:n.t,children:[T[n.t]?.body,...kids(n).flatMap(kids)].filter(Boolean)}:n;
function clusters(list){
  const bags=list.map(u=>bag(flatRef(u))),parent=list.map((_,i)=>i),near=list.map(()=>null);
  const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    if(isRef(list[i])&&isRef(list[j])&&list[i].t===list[j].t&&/^S/.test(list[i].t)){parent[find(j)]=find(i);continue;}
    const a=dim(list[i]),b=dim(list[j]);
    if(!a.width||!b.width||Math.abs(a.width-b.width)/Math.max(a.width,b.width)>0.08)continue;
    const s=jaccard(bags[i],bags[j]);
    if(s>=0.5)parent[find(j)]=find(i);
    else if(s>=0.25){if(!near[i]||near[i][1]<s)near[i]=[j,s];if(!near[j]||near[j][1]<s)near[j]=[i,s];}
  }
  const groups=new Map();list.forEach((_,i)=>{const r=find(i);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(i);});
  return {groups:[...groups.values()],near};
}
const AUTO=/^(Frame|Group|Rectangle|Vector|Ellipse|Line|Union|Subtract|image|Mask group)\b[\s\d]*$/i;
function label(n){
  const nm=isRef(n)?T[n.t]?.body?.name:n.name;
  if(nm&&!AUTO.test(nm))return nm;
  const tx=texts(n)[0];if(tx)return '⟨'+tx+'⟩';
  const src=JSON.stringify(isRef(n)?T[n.t]?.body:n).match(/([^"/\\]+)\.svg/);return src?src[1]+'.svg':nm||'';
}
function skeleton(n){if(!n)return '';if(isRef(n))return n.t;return (n.tag||'')+'('+kids(n).map(skeleton).join(',')+')';}

function outline(){
  const section=opt('--section');
  const bytes=statSync(file).size;
  console.log(`${ast.name||''} fileKey=${ast.fileKey||''} ast=${(bytes/1024).toFixed(0)}KB templates=${Object.keys(T).length} styles=${Object.keys(G).length}`);
  if(ast.connectors?.length){
    console.log('\nconnectors (from --label--> to):');
    for(const c of ast.connectors){
      const nm=(id,alt)=>alt||byId.get(String(id).split('/')[0])?.name||'';
      console.log(`  ${c.from}${c.fromName||nm(c.from)?' "'+short(c.fromName||nm(c.from),30)+'"':''} --${c.label||''}--> ${c.to}${c.toName||nm(c.to)?' "'+short(c.toName||nm(c.to),30)+'"':''}`);
    }
  }
  let entries=units();
  if(section)entries=entries.filter(e=>e.group&&(A(e.group)===section||A(e.group).startsWith(section+'/')));
  const byGroup=new Map();
  for(const e of entries){if(e.unit){const g=e.group?A(e.group):'(root)';if(!byGroup.has(g))byGroup.set(g,{group:e.group,list:[]});byGroup.get(g).list.push(e.unit);}}
  const all=rest.includes('--all');
  const isNote=u=>!isRef(u)&&u.tag==='TEXT';
  const allScreens=[...byGroup.values()].flatMap(g=>g.list).filter(u=>!isNote(u)&&(all||count(u)>12));
  // global clustering so states split across sections still group together
  const {groups,near}=clusters(allScreens);
  const gOf=new Map();let gi=0;const summary=[];
  for(const idxs of groups)if(idxs.length>1){gi++;for(const i of idxs)gOf.set(allScreens[i],gi);summary.push('g'+gi+': '+idxs.map(i=>A(allScreens[i])).join(' '));}
  const nearOf=new Map(allScreens.map((u,i)=>[u,near[i]&&!gOf.has(u)?allScreens[near[i][0]]:null]));
  // distinctive texts: drop those present in many screens (nav, headers)
  const big=allScreens.filter(u=>count(u)>100);
  const df=new Map();for(const u of big)for(const t of new Set(texts(u)))df.set(t,(df.get(t)||0)+1);
  const common=big.length<4?Infinity:Math.max(3,big.length*0.25);
  const line=u=>{const d=dim(u);
    const tx=[...new Set(texts(u))].filter(t=>(df.get(t)||0)<common).slice(0,5).map(s=>short(s,20)).join(' | ');
    return `${gOf.has(u)?'≈g'+gOf.get(u)+' ':''}${A(u)} ${isRef(u)?'<'+u.t+'> ':''}"${short(label(u),30)}" ${d.width??'?'}x${d.height??'?'} n=${count(u)}${tx?'  '+tx:''}${nearOf.get(u)?'  ~'+A(nearOf.get(u)):''}`;};
  console.log('\nunits (n=nodes; ≈gN = same screen/part in different states → build once, use diff; ~id = partly similar):');
  for(const [gid,{group,list}] of byGroup){
    console.log(group?`SECTION ${A(group)} "${short(group.name||'',50)}" ${list.length} units`:'(root)');
    const notes=list.filter(isNote);
    const screens=list.filter(u=>allScreens.includes(u)),small=list.filter(u=>!isNote(u)&&!allScreens.includes(u));
    for(const u of screens)console.log('  '+line(u));
    if(small.length){const by=new Map();for(const u of small){const k=short(label(u),24);by.set(k,(by.get(k)||0)+1);}
      console.log('  small parts ('+small.length+'): '+[...by].map(([k,c])=>k+(c>1?'×'+c:'')).join(', ')+'  (--all to list)');}
    if(notes.length)console.log('  notes: '+notes.map(n=>'"'+short(n.text??n.name,all?400:90)+'"').join(' ; '));
  }
  if(summary.length)console.log('\nstate groups:\n  '+summary.join('\n  '));
  // components: rank by uses × size, the reuse value
  const comps=Object.entries(T).filter(([k])=>!/^T\d/.test(k)).map(([k,t])=>({k,t,n:expandedSize(k)}));
  comps.sort((a,b)=>(b.t.uses||1)*b.n-(a.t.uses||1)*a.n);
  if(comps.length){
    const shown=all?comps:comps.slice(0,40);
    console.log('\ncomponents by reuse value (C=component, S=screen shell; ×uses n=nodes):');
    for(const {k,t,n} of shown){
      const api=[t.params&&'props:'+Object.keys(t.params).join(','),t.variants&&'variants:'+Object.keys(t.variants).join(','),
        [...new Set(JSON.stringify(t.body).match(/"tag":"slot\d+"/g)?.map(s=>s.match(/slot\d+/)[0]))].join(',')].filter(Boolean).join(' ');
      console.log(`  ${k} ×${t.uses??'?'} n=${n} "${short(label(t.body),28)}"${api?' '+api:''}`);
    }
    if(comps.length>shown.length)console.log(`  … +${comps.length-shown.length} smaller (--all)`);
    const sk=new Map();
    for(const {k,t} of comps){const s=skeleton(t.body);if(s.length<12)continue;if(!sk.has(s))sk.set(s,[]);sk.get(s).push(k);}
    const merges=[...sk.values()].filter(v=>v.length>1);
    if(merges.length)console.log('\nsame skeleton, different values (likely one component with props/variants):\n  '+merges.map(v=>v.join('≈')).join('  '));
  }
}

// ---------- tokens ----------
function tokens(){
  const refs=new Map();
  const src=JSON.stringify({n:ast.nodes,t:T});
  for(const m of src.matchAll(/"([A-Za-z]+_?[A-Za-z0-9]+)"/g))if(m[1] in G)refs.set(m[1],(refs.get(m[1])||0)+1);
  const tally=new Map();const add=(cat,k,w)=>{if(!tally.has(cat))tally.set(cat,new Map());const t=tally.get(cat);t.set(k,(t.get(k)||0)+w);};
  const colorsIn=v=>JSON.stringify(v).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)||[];
  for(const [k,w] of refs){
    const v=style(k);if(!v)continue;
    const s=JSON.stringify(v);
    if(Array.isArray(v)||v.backgroundImage||v.gradient||v.fontColor){for(const c of colorsIn(v))add('fill',c.replace(/\s+/g,''),w);if(s.includes('gradient'))add('gradient',s.match(/(linear|radial|conic)-gradient\([^"]*\)/)?.[0]||k,w);continue;}
    if(v.family||v.size){add('type',`${v.family||''} ${v.size||''}${v.lineHeight?'/'+v.lineHeight:''} w${v.weight||''}`,w);if(v.color)add('text-color',String(v.color).replace(/\s+/g,''),w);continue;}
    if(v.colors||v.strokeWeight){for(const c of colorsIn(v.colors))add('stroke',c.replace(/\s+/g,'')+' '+(v.strokeWeight||''),w);continue;}
    if(v.boxShadow||v.backdropFilter||v.filter||v.textShadow){add('effect',v.boxShadow||v.textShadow||v.backdropFilter||v.filter,w);continue;}
    if(v.gap)add('gap',v.gap,w);if(v.padding)add('padding',v.padding,w);
  }
  walk(ast.nodes,n=>{if(n.borderRadius)add('radius',n.borderRadius,1);});
  for(const [,b] of bodies())walk([b],n=>{if(n.borderRadius&&typeof n.borderRadius==='string')add('radius',n.borderRadius,1);});
  for(const [cat,t] of tally){
    const top=[...t].sort((a,b)=>b[1]-a[1]).slice(0,cat==='effect'||cat==='gradient'?8:20);
    console.log(cat+': '+top.map(([k,c])=>short(k,cat==='effect'||cat==='gradient'?90:48)+' ×'+c).join(' ; '));
  }
}

// ---------- diff ----------
function diff(aSpec,bSpec){
  const A=locate(aSpec),B=locate(bSpec);let out=[],limit=250;
  const key=n=>isRef(n)?(/^T/.test(n.t)&&!kids(n).length?T[n.t]?.body?.tag??'@'+n.t:'@'+n.t):n.tag;
  const emit=s=>{if(out.length<limit)out.push(s);else if(out.length===limit)out.push('… truncated; diff a deeper path');};
  const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
  (function rec(a,b,path,root){
    if(isRef(a)!==isRef(b)||(isRef(a)&&a.t!==b.t)){ // compare a template instance with inline content via its body
      if(isRef(a)&&!kids(a).length)a=T[a.t]?.body||a;
      if(isRef(b)&&!kids(b).length)b=T[b.t]?.body||b;
    }
    if(!root&&key(a)!==key(b)){emit(`± ${path} ${key(a)} → ${key(b)} n=${count(b)}${texts(b).length?' ⟨'+short(texts(b).slice(0,4).join(' | '),80)+'⟩':''}`);return;}
    const ka=new Set(Object.keys(a)),kb=new Set(Object.keys(b));
    for(const k of new Set([...ka,...kb])){
      if(['children','id','canvasXY'].includes(k))continue;
      if(!same(a[k],b[k]))emit(`~ ${path} ${k}: ${a[k]===undefined?'∅':short(val(a[k]),70)} → ${b[k]===undefined?'∅':short(val(b[k]),70)}`);
    }
    const ca=kids(a),cb=kids(b);
    // LCS alignment on keys
    const m=ca.length,n=cb.length,L=Array.from({length:m+1},()=>new Array(n+1).fill(0));
    for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)L[i][j]=key(ca[i])===key(cb[j])?L[i+1][j+1]+1:Math.max(L[i+1][j],L[i][j+1]);
    let i=0,j=0;
    while(i<m||j<n){
      if(i<m&&j<n&&key(ca[i])===key(cb[j])){rec(ca[i],cb[j],path+'/'+j,false);i++;j++;}
      else if(j<n&&(i>=m||L[i][j+1]>=L[i+1][j])){emit(`+ ${path}/${j} ${key(cb[j])}${cb[j].id!==undefined?' #'+cb[j].id:''} n=${count(cb[j])}${texts(cb[j]).length?' ⟨'+short(texts(cb[j]).slice(0,4).join(' | '),80)+'⟩':''}`);j++;}
      else {emit(`- ${path}/${i}(A) ${key(ca[i])} n=${count(ca[i])}${texts(ca[i]).length?' ⟨'+short(texts(ca[i]).slice(0,4).join(' | '),80)+'⟩':''}`);i++;}
    }
  })(A,B,bSpec,true);
  const total=count(B);
  console.log(`diff ${aSpec} → ${bSpec}: ${out.length} changes (B has ${total} nodes; paths are B-side)`);
  console.log(out.join('\n'));
  const st=new Set();for(const l of out)for(const m of l.matchAll(/(?:→|:)\s*([A-Za-z]+_?[A-Za-z0-9]+)\b/g))if(m[1] in G)st.add(m[1]);
  if(st.size){console.log('\nstyles:');for(const k of [...st].sort())console.log(k+' '+JSON.stringify(style(k)));}
}

// ---------- check ----------
function check(dirs){
  const units=[];let i;while((i=dirs.indexOf('--unit'))>=0){units.push(dirs[i+1]);dirs.splice(i,2);}
  const roots=units.length?units.map(locate):ast.nodes;
  // templates reachable from the chosen roots
  const used=new Set();const visit=n=>{if(!n)return;if(isRef(n)&&!used.has(n.t)){used.add(n.t);visit(T[n.t]?.body);}kids(n).forEach(visit);};roots.forEach(visit);
  const allTexts=new Set(texts({children:roots,tag:'ROOT'}));
  for(const [,t] of Object.entries(T).filter(([k])=>used.has(k)))for(const v of [...Object.values(t.params||{}),...Object.values(t.variants||{}).flatMap(Object.values)])if(typeof v==='string'&&!(v in G)&&!/\.(svg|png|jpe?g)$/i.test(v)&&!/^-?[\d.]+$/.test(v))allTexts.add(v.trim());
  const images=new Set();
  const keys=new Set();const src0=JSON.stringify({n:roots,t:[...used].map(k=>T[k])});
  for(const m of src0.matchAll(/"([A-Za-z]+_?[A-Za-z0-9]+)"/g))if(m[1] in G)keys.add(m[1]);
  const src=src0+JSON.stringify([...keys].map(k=>G[k]));
  for(const m of src.matchAll(/[^"(/\\]+\.(?:svg|png|jpe?g|webp|gif)\b/gi))images.add(m[0]);
  let code='';const exts=new Set(['.js','.jsx','.ts','.tsx','.vue','.svelte','.html','.css','.scss','.less','.json','.md','.mjs']);
  const rd=p=>{let s;try{s=statSync(p);}catch{return;}
    if(s.isDirectory()){if(/^(node_modules|\.git|dist|build|\.next|\.melonbuild)$/.test(basename(p)))return;for(const f of readdirSync(p))rd(join(p,f));}
    else if(exts.has(extname(p))&&s.size<2e6)code+=readFileSync(p,'utf8')+'\n';};
  for(const d of dirs.length?dirs:['.'])rd(d);
  const flat=code.replace(/\s+/g,' ');
  const missT=[...allTexts].filter(t=>t.length>1&&!flat.includes(t.replace(/\s+/g,' ')));
  const missI=[...images].filter(i=>!code.includes(i)&&!code.includes(i.replace(/;/g,'_')));
  console.log(`texts: ${allTexts.size-missT.length}/${allTexts.size} found in code; images: ${images.size-missI.length}/${images.size} referenced`);
  if(missT.length)console.log('missing texts:\n  '+missT.slice(0,60).map(t=>short(t,80)).join('\n  ')+(missT.length>60?'\n  … +'+(missT.length-60):''));
  if(missI.length)console.log('unreferenced images:\n  '+missI.slice(0,40).join('\n  ')+(missI.length>40?'\n  … +'+(missI.length-40):''));
}

// ---------- assets ----------
// CLI saves images as <sha256>.<ext>; give them names from their Figma layers so code stays readable.
function assets(apply){
  const names=new Map(); // filename -> layer name
  const fileOf=v=>{if(typeof v!=='string')return null;const m=v.match(/(?:^|[\/("'])([a-f0-9]{64}\.[a-z]+)/);return m?m[1]:null;};
  const fillOwner=new Map();
  const note=(v,name)=>{const f=fileOf(v);if(f&&name&&!names.has(f))names.set(f,name);};
  const paramNames=new Map(); // template -> param -> layer name
  const up=new Map();walk(ast.nodes,(n,d,p)=>{up.set(n,p);});for(const [,b] of bodies())walk([b],(n,d,p)=>{up.set(n,p);});
  const GENERIC=/^(Frame|Group|Rectangle|Vector|Ellipse|Line|Union|Subtract|image|Mask group|形状|形状结合|蒙版|编组|路径|矩形|椭圆)[\s\d]*$/i;
  const nm=(n,p)=>{for(let x=n,i=0;x&&i<6;x=i===0?p:up.get(x),i++)if(x.name&&!GENERIC.test(x.name))return x.name;return n.name;};
  for(const [tn,t] of Object.entries(T))walk([t.body],(n,d,p)=>{
    for(const [k,v] of Object.entries(n)){
      if(v&&typeof v==='object'&&v.$param&&(k==='src'||k==='fills')){if(!paramNames.has(tn))paramNames.set(tn,{});paramNames.get(tn)[v.$param]=nm(n,p);}
    }
  });
  const visit=(n,p)=>{
    if(isRef(n)){const pn=paramNames.get(n.t)||{},t=T[n.t]||{};
      for(const src of [n.args||{},t.params||{},...Object.values(t.variants||{})])for(const [k,v] of Object.entries(src)){if(pn[k])note(v,pn[k]);if(typeof v==='string'&&v in G)fillOwner.set(v,fillOwner.get(v)||pn[k]||t.body?.name);}
      return;}
    if(n.src)note(n.src,nm(n,p));
    if(typeof n.fills==='string'&&!fillOwner.has(n.fills))fillOwner.set(n.fills,nm(n,p));
  };
  walk(ast.nodes,(n,d,p)=>{visit(n,p);});for(const [,b] of bodies())walk([b],(n,d,p)=>{visit(n,p);});
  for(const [k,v] of Object.entries(G)){const s=JSON.stringify(v);const f=fileOf(s.replace(/\\"/g,'"'));if(f)note(f,fillOwner.get(k)||'image');}
  // also any file referenced but unnamed
  for(const m of JSON.stringify({n:ast.nodes,t:T,g:G}).matchAll(/[a-f0-9]{64}\.[a-z]+/g))if(!names.has(m[0]))names.set(m[0],'image');
  const slug=s=>{const seg=String(s).split('/').map(x=>x.trim()).filter(Boolean);
    for(const part of [seg.at(-1),...seg.slice(0,-1).reverse()]){const clean=(part||'').toLowerCase().replace(/\b(frame|group|vector|rectangle|union|subtract|mask|layer)\b/g,' ').replace(/\b\d+\b/g,' ');
      const ascii=clean.replace(/[^a-z0-9]+/g,'-').replace(/^[-\d]+|-+$/g,'');if(ascii.length>=2)return ascii.slice(0,40);
      const cjk=clean.replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^[-\d]+|-+$/g,'');if(/[\u4e00-\u9fff]/.test(cjk))return cjk.slice(0,24);}
    return 'img';};
  const taken=new Map(),plan=[];
  for(const [f,name] of names){
    const ext=f.split('.').pop();let base=(ext==='svg'&&!/icon|logo/.test(slug(name))?'icon-':'')+slug(name);
    if(ext!=='svg')base=slug(name)==='img'?'image':slug(name);
    let out=base+'.'+ext;if(taken.has(out))out=base+'-'+f.slice(0,4)+'.'+ext;taken.set(out,f);plan.push([f,out,name]);
  }
  if(!apply){for(const [f,o,n] of plan)console.log(f.slice(0,10)+'… → '+o+'  ("'+short(n,40)+'")');console.log(plan.length+' images. Run with --apply to rename files and rewrite the AST.');return;}
  // locate image dir from the first relative reference
  const anyRef=JSON.stringify({n:ast.nodes,t:T,g:G}).match(/([^"(]*?)([a-f0-9]{64}\.[a-z]+)/);
  if(!anyRef){console.log('no local images');return;}
  const dirOf=join(file,'..',anyRef[1].replace(/^url\(|['"]/g,''));
  let text=readFileSync(file,'utf8'),moved=0;
  for(const [f,o] of plan){const from=join(dirOf,f),to=join(dirOf,o);if(existsSync(from)&&!existsSync(to)){renameSync(from,to);moved++;}text=text.split(f).join(o);}
  writeFileSync(file,text);
  console.log(`renamed ${moved}/${plan.length} files in ${dirOf}; AST rewritten`);
}

try{
  if(cmd==='outline')outline();
  else if(cmd==='assets')assets(rest.includes('--apply'));
  else if(cmd==='tokens')tokens();
  else if(cmd==='show'){const d=Number(opt('--depth','99'));if(!rest[0])throw new Error('show needs an id, template or path');show(locate(rest[0]),d);}
  else if(cmd==='diff'){if(rest.length<2)throw new Error('diff needs two ids');diff(rest[0],rest[1]);}
  else if(cmd==='texts'){const n=rest[0]?locate(rest[0]):{tag:'ROOT',children:ast.nodes};console.log([...new Set(texts(n))].join('\n'));}
  else if(cmd==='check')check(rest);
  else {console.log(USAGE);process.exit(1);}
}catch(e){console.error('mb: '+e.message);process.exit(1);}
