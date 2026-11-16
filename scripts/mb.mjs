#!/usr/bin/env node
// MelonBuild AST query tool: read the AST in small, targeted slices instead of loading it whole.
// Zero dependencies. Node >= 18.
import {readFileSync,readdirSync,statSync,renameSync,existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,basename,extname} from 'node:path';

const USAGE=`mb.mjs <command> <ast.json> [args]

  outline  <ast> [--section <id>] [--all]   screens, state groups, components, connectors
  tokens   <ast>                       colors / type / radius / spacing / shadow usage
  show     <ast> <target...> [--depth N] [--expand]
                                       compact subtree(s) + resolved styles; several targets
                                       share one styles block; --expand inlines component refs
  diff     <ast> <idA> <idB>           what changes from A to B (state merging)
  texts    <ast> [id]                  all text content (deduped)
  check    <ast> <dir...> [--unit id]  texts / images missing from generated code
  assets   <ast> [--apply]             flag plain-shape SVGs (→ CSS); for files from older CLIs
                                       also rename hashed names, merge duplicates, repair SVGs
  subset   <ast> <id...> -o <out>      keep only these units (+ the templates and styles they use);
                                       then: melonbuild download-images <out> --image-dir … --output …
  prune    <ast> <code-dir...> [--apply]  delete downloaded images the code never references

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
// 图片链接只显示短标识：远程签名 URL 取图片 id 前 8 位，本地路径取文件名
const shortImage=v=>v.replace(/https:\/\/[^\s"')]*?\/images\/([0-9a-f-]{8})[^\s"')]*/g,'img:$1').replace(/(?:\.{0,2}\/)?(?:[^\s"'(),]*\/)+([^\/\s"'(),]+\.(?:svg|png|jpe?g|webp|gif))/g,'$1');
const shortJSON=v=>shortImage(JSON.stringify(v));
const val=v=>{
  if(v&&typeof v==='object'){
    if(typeof v.$param==='string')return '{'+v.$param+'}';
    if('x' in v&&'y' in v&&Object.keys(v).length===2)return v.x+','+v.y;
    return JSON.stringify(v);
  }
  if(typeof v==='string'){
    v=shortImage(v);
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
// template parameter environment of a ref: params → variant → args (args may point to an outer env)
function envOf(ref,outer={}){
  const t=T[ref.t]||{};const e={...(t.params||{}),...(t.variants?.[ref.args?.variant]||{}),...(ref.args||{})};
  for(const k in e){const v=e[k];if(v&&typeof v==='object'&&typeof v.$param==='string'&&v.$param in outer)e[k]=outer[v.$param];}
  return e;
}
const bind=(v,env)=>v&&typeof v==='object'&&typeof v.$param==='string'&&env&&v.$param in env?env[v.$param]:v;
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
function attrLine(n,env){
  const parts=[];const v=k=>bind(n[k],env);
  for(const k of Object.keys(n)){
    if(['tag','t','id','name','children','text','args','__template','__path'].includes(k))continue;
    if(k==='width'&&'height' in n){parts.push(val(v('width'))+'x'+val(v('height')));continue;}
    if(k==='height'&&'width' in n)continue;
    const x=v(k);if(x===null||x===undefined)continue; // param resolved to "absent"
    parts.push(k+'='+val(x));
  }
  return parts.join(' ');
}
function show(targets,maxDepth,expand){
  const usedStyles=new Set(),usedTemplates=new Set(),shown=new Set(targets.filter(t=>t.root.__template).map(t=>t.root.__template));
  const note=v=>{if(typeof v==='string'&&v in G)usedStyles.add(v);};
  for(const {spec,root} of targets){
    const lines=[];
    // extra：展开模板多出来的缩进层数，不占 --depth 的预算
    (function rec(n,d,path,env,extra=0){
      const pad='  '.repeat(d);
      if(isRef(n)&&/^T\d/.test(n.t)&&!kids(n).length&&T[n.t]?.body&&!T[n.t].params){
        // tiny compression templates: inline them instead of making the reader look them up
        return rec({...T[n.t].body,...(n.id!==undefined?{id:n.id}:{})},d,path,env,extra);
      }
      if(isRef(n)){
        const args=Object.entries(n.args||{}).map(([k,v])=>{v=bind(v,env);note(v);return k+'='+(v===null||v===undefined?'∅':val(v));}).join(' ');
        if(expand&&T[n.t]?.body&&!/^S/.test(n.t)&&d-extra<maxDepth){
          lines.push(pad+'<'+n.t+(n.id!==undefined?' #'+n.id:'')+(args?' '+args:'')+'> expanded  ['+path+']');
          const inner=envOf(n,env);
          for(const v of Object.values(inner))note(v);
          // slot contents are placed where <slotN/> sits in the body
          const slots=Object.fromEntries(kids(n).map(s=>[s.tag,kids(s)]));
          return rec({...T[n.t].body,__slots:slots},d+1,path,inner,extra+1);
        }
        usedTemplates.add(n.t);
        lines.push(pad+'<'+n.t+(n.id!==undefined?' #'+n.id:'')+(args?' '+args:'')+(kids(n).length?'>':' />')+'  ['+path+']');
        if(kids(n).length&&d-extra<maxDepth)kids(n).forEach((c,i)=>rec(c,d+1,path+'/'+i,env,extra));
        return;
      }
      if(/^slot\d+$/.test(n.tag||'')&&!kids(n).length&&env&&env.__slots?.[n.tag]){
        lines.push(pad+'<'+n.tag+'> (filled)');env.__slots[n.tag].forEach((c,i)=>rec(c,d+1,path+'/'+i,env,extra));return;
      }
      if(n.__slots)env={...env,__slots:n.__slots};
      for(const k of Object.keys(n))note(bind(n[k],env));
      const head=(n.tag||'?')+(n.id!==undefined?' #'+n.id:'')+(n.name&&!AUTO.test(n.name)?' "'+short(n.name,40)+'"':'');
      const tv=bind(n.text,env);
      const text=n.text!==undefined?'  ⟨'+(tv&&typeof tv==='object'?val(tv):short(tv??'∅',120))+'⟩':'';
      const a=attrLine(Object.fromEntries(Object.entries(n).filter(([k])=>k!=='__slots')),env);
      lines.push(pad+head+(a?' '+a:'')+text);
      const c=kids(n);
      if(!c.length)return;
      if(d-extra>=maxDepth){lines.push(pad+'  … '+c.length+' children / '+c.reduce((s,x)=>s+count(x),0)+' nodes  → show '+path+' ');return;}
      c.forEach((x,i)=>rec(x,d+1,path+'/'+i,env,extra));
    })(root,0,spec,{});
    // template header when showing a template
    if(root.__template){
      const t=T[root.__template];
      const meta=['uses='+(t.uses??'?'),'nodes='+expandedSize(root.__template)];
      if(t.params)meta.push('params '+shortJSON(t.params));
      if(t.variants)meta.push('variants '+shortJSON(t.variants));
      for(const v of [...Object.values(t.params||{}),...Object.values(t.variants||{}).flatMap(Object.values)])note(v);
      lines.unshift('template '+root.__template+' '+meta.join(' '));
    }
    if(isRef(root))lines.push('  (instance of '+root.t+': show '+root.t+' for its body; only args/slots differ per instance)');
    if(targets.length>1)console.log('=== '+spec);
    console.log(lines.join('\n'));
  }
  const pending=[...usedTemplates].filter(t=>!shown.has(t));
  if(pending.length){
    console.log('\nrefs: '+pending.map(t=>t+'(uses='+(T[t]?.uses??'?')+',nodes='+expandedSize(t)+(T[t]?.params?',params='+Object.keys(T[t].params).join('|'):'')+(T[t]?.variants?',variants='+Object.keys(T[t].variants).join('|'):'')+')').join(' '));
    console.log('  (read several at once: show <ast> '+pending.slice(0,6).join(' ')+' — or --expand to inline them here)');
  }
  if(usedStyles.size){
    console.log('\nstyles:');
    for(const k of [...usedStyles].sort())console.log(k+' '+shortJSON(style(k)));
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
      // a SECTION about the size of a screen is one screen made of parts, not a board of screens
      if(!isRef(n)&&n.tag==='SECTION'&&group&&n.width&&n.width<=2000&&n.height<=6000){out.push({unit:n,group});continue;}
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
const dim=n=>{if(!isRef(n))return n;const b=T[n.t]?.body||{},e=envOf(n);return {...b,width:bind(b.width,e),height:bind(b.height,e)};};
const wh=d=>(typeof d.width==='number'?d.width:'?')+'x'+(typeof d.height==='number'?d.height:'?');
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
const statePrefix=n=>{const nm=String((isRef(n)?T[n.t]?.body?.name:n.name)||'');const m=nm.match(/^(.{2,20}?)\s*[-_—–·|｜/]\s*\S/);return m&&!AUTO.test(m[1])?m[1].replace(/页$/,'').trim():null;};
function clusters(list){
  const bags=list.map(u=>bag(flatRef(u))),parent=list.map((_,i)=>i),near=list.map(()=>null);
  const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    if(isRef(list[i])&&isRef(list[j])&&list[i].t===list[j].t&&/^S/.test(list[i].t)){parent[find(j)]=find(i);continue;}
    // designers name state frames "<screen>-<state>": same prefix + same width = same screen
    const pi=statePrefix(list[i]),pj=statePrefix(list[j]);
    if(pi&&pi===pj&&dim(list[i]).width===dim(list[j]).width){parent[find(j)]=find(i);continue;}
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


// ---------- canvas regions ----------
// 画板上常见的组织方式：大块背景圈出一个分区，分区里的大标题是分区名，小标题领着一排屏幕。
// 背景外面的屏幕通常是旧稿、备选方案或附件。
const xy=n=>{const p=n?.canvasXY;return p&&typeof p.x==='number'?p:null;};
function canvasRegions(board,screens){
  const kids=kids0(board);
  const area=n=>{const d=dim(n);return (d.width||0)*(d.height||0);};
  const screenArea=Math.max(...screens.map(area).filter(Boolean),1);
  const box=n=>{const p=xy(n),d=dim(n);return p&&d.width&&d.height?{x:p.x,y:p.y,w:d.width,h:d.height}:null;};
  const inside=(p,b)=>p&&p.x>=b.x&&p.x<b.x+b.w&&p.y>=b.y&&p.y<b.y+b.h;
  const backs=kids.filter(n=>!isRef(n)&&!kids0(n).length&&n.tag!=='TEXT'&&area(n)>=screenArea*4).map(box).filter(Boolean)
    .filter(b=>screens.filter(u=>inside(xy(u),b)).length>=2);
  const titles=kids.filter(n=>!isRef(n)&&n.tag==='TEXT'&&xy(n)).map(n=>({text:String(n.text??n.name??''),...xy(n),size:dim(n).height||0}));
  if(!backs.length&&!titles.length)return null;
  return u=>{
    const p=xy(u);if(!p)return {region:null,row:null};
    const back=backs.filter(b=>inside(p,b)).sort((a,b)=>a.w*a.h-b.w*b.h)[0];
    if(backs.length&&!back)return {region:'⚠ 不在任何分区里（多半是旧稿/备选方案/附件，默认不实现）',row:null};
    const own=titles.filter(t=>!back||inside(t,back));
    const head=[...own].sort((a,b)=>b.size-a.size||a.y-b.y)[0];
    const above=own.filter(t=>t!==head&&t.y<=p.y).sort((a,b)=>b.y-a.y||Math.abs(a.x-p.x)-Math.abs(b.x-p.x))[0];
    return {region:head?.text??(back?'(未命名分区)':null),row:above?.text??null};
  };
}
const kids0=n=>Array.isArray(n?.children)?n.children:[];

// 宿主外观：手机状态栏、小程序胶囊、浏览器栏、Home Indicator……属于运行环境，不属于页面
const HOST=/状态栏|status ?bar|home ?indicator|胶囊|小程序|capsule|safari|toolbar|刘海|notch|navigation bar\/system|system\/|^9:41/i;
function hostChrome(){
  const out=new Map();
  for(const [k,t] of Object.entries(T)){
    const nm=String(t.body?.name??''),tx=texts(t.body);
    // 名字点明是系统外观，或者全部文案都是时间、电量、运营商这类状态栏内容（含页面标题的导航栏不算）
    const statusOnly=tx.length>0&&tx.every(x=>/^\d{1,2}:\d{2}( ?[AP]M)?$|^\d{1,3}%$|^(sketch|carrier|中国移动|中国联通|中国电信|5G|4G|LTE|wi-?fi)$/i.test(x.trim()));
    if(HOST.test(nm)||statusOnly)out.set(k,nm||label(t.body));
  }
  return out;
}

// 同一状态组里选基准帧：与组内其它帧平均最相似的那个；结构差太多的单独看
function baseOf(members){
  const bags=members.map(u=>bag(flatRef(u)));
  const sim=(i,j)=>jaccard(bags[i],bags[j]);
  let best=0,bestScore=-1;
  members.forEach((_,i)=>{const sc=members.reduce((t,_,j)=>t+(i===j?0:sim(i,j)),0)/Math.max(1,members.length-1);if(sc>bestScore){best=i;bestScore=sc;}});
  return {base:members[best],scores:members.map((_,i)=>i===best?1:sim(best,i))};
}

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
  const allScreens=[...byGroup.values()].flatMap(g=>g.list).filter(u=>!isNote(u)&&count(u)>12);
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
    return `${gOf.has(u)?'≈g'+gOf.get(u)+' ':''}${A(u)} ${isRef(u)?'<'+u.t+'> ':''}"${short(label(u),30)}" ${wh(d)} n=${count(u)}${tx?'  '+tx:''}${nearOf.get(u)?'  ~'+A(nearOf.get(u)):''}`;};
  const board=ast.nodes.length===1&&!isRef(ast.nodes[0])&&['SECTION','CANVAS'].includes(ast.nodes[0].tag)?ast.nodes[0]:null;
  const where=board?canvasRegions(board,allScreens):null;
  const host=hostChrome();
  console.log('\nunits (n=nodes; ≈gN = same screen in different states, build once; ~id = partly similar):');
  const printList=(list,pad)=>{
    const notes=list.filter(isNote);
    const screens=list.filter(u=>allScreens.includes(u)),small=list.filter(u=>!isNote(u)&&!allScreens.includes(u));
    for(const u of screens)console.log(pad+line(u));
    if(all)for(const u of small)console.log(pad+'· '+line(u));
    if(small.length&&!all){const by=new Map();for(const u of small){const k=short(label(u),24);by.set(k,(by.get(k)||0)+1);}
      console.log(pad+'small parts ('+small.length+'): '+[...by].map(([k,c])=>k+(c>1?'×'+c:'')).join(', ')+'  (--all to list)');}
    const txt=n=>String(n.text??n.name??'');
    const ann=notes.filter(n=>!(txt(n).length<=10&&!/[，。,.:：；;!?！？]/.test(txt(n))));
    if(ann.length)console.log(pad+'notes (requirements): '+ann.map(n=>'"'+short(txt(n),all?400:90)+'"').join(' ; '));
  };
  if(where){
    // 按画布分区与行标题组织：设计师就是这样告诉你「哪些是同一页、哪套是正式稿」的
    const groups=new Map();
    for(const u of kids0(board)){const {region,row}=where(u);const k=region??'(未归入分区)';if(!groups.has(k))groups.set(k,new Map());
      const rows=groups.get(k);const r=row??'';if(!rows.has(r))rows.set(r,[]);rows.get(r).push(u);}
    const order=[...groups.keys()].sort((a,b)=>(a.startsWith('⚠')?1:0)-(b.startsWith('⚠')?1:0));
    for(const k of order){console.log('REGION '+k);for(const [row,list] of groups.get(k)){if(row)console.log('  ['+row+']');printList(list.filter(u=>!(isNote(u)&&String(u.text??'').length<=10)),row?'    ':'  ');}}
    for(const [gid,{group,list}] of byGroup)if(group&&group!==board){console.log(`SECTION ${A(group)} "${short(group.name||'',50)}" ${list.length} units`);printList(list,'  ');}
  }else for(const [gid,{group,list}] of byGroup){
    console.log(group?`SECTION ${A(group)} "${short(group.name||'',50)}" ${list.length} units`:'(root)');
    printList(list,'  ');
    const txt=n=>String(n.text??n.name??'');
    const titles=list.filter(isNote).filter(n=>txt(n).length<=10&&!/[，。,.:：；;!?！？]/.test(txt(n)));
    if(titles.length)console.log('  titles: '+titles.map(n=>'"'+txt(n)+'"').join(' ; '));
  }
  if(gi){
    console.log('\nstate groups (base = 写组件时作为基准的帧；其它帧用 diff 对比基准，similarity<0.3 的结构差异大，单独 show):');
    let g=0;
    for(const idxs of groups)if(idxs.length>1){g++;
      const members=idxs.map(i=>allScreens[i]);const {base,scores}=baseOf(members);
      const stray=u=>where&&where(u).region?.startsWith('⚠')?' ⚠分区外':'';
      console.log(`  g${g} base=${A(base)} "${short(label(base),24)}"${stray(base)}`);
      const others=members.filter(u=>u!==base).sort((a,b)=>scores[members.indexOf(b)]-scores[members.indexOf(a)]);
      const fmt=u=>`${A(u)} "${short(label(u),16)}" ${scores[members.indexOf(u)].toFixed(2)}${stray(u)}`;
      const near=others.filter(u=>scores[members.indexOf(u)]>=0.3),far=others.filter(u=>scores[members.indexOf(u)]<0.3);
      if(near.length)console.log('     diff 对比: '+near.map(fmt).join(' ; '));
      if(far.length)console.log('     单独 show: '+far.map(fmt).join(' ; '));
    }
  }
  // 不是模板的宿主外观图层（小程序胶囊、Home Indicator……），按名字列出
  const hostNodes=new Map();
  const scan=n=>{if(!n||typeof n!=='object')return;if(isRef(n)){kids0(n).forEach(scan);return;}
    if(n.name&&HOST.test(n.name))hostNodes.set(n.name,(hostNodes.get(n.name)||0)+1);else kids0(n).forEach(scan);};
  ast.nodes.forEach(scan);for(const [k,t] of Object.entries(T))if(!host.has(k))scan(t.body);
  if(host.size||hostNodes.size)console.log('\nhost chrome (运行环境的外观，不写进页面组件；check 会忽略模板里的文案): '+
    [...[...host].map(([k,n])=>`${k} "${short(n,24)}"`),...[...hostNodes].map(([n,c])=>`"${short(n,24)}"${c>1?'×'+c:''}`)].join(', '));

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
    // 同名但结构不同的模板：同一个组件被画了好几版。以使用最多的为准，其余用 diff 看差异再决定做成变体还是忽略
    const byName=new Map();
    for(const {k,t,n} of comps){const nm=String(t.body?.name??'');if(!nm||AUTO.test(nm)||n<8||host.has(k))continue;if(!byName.has(nm))byName.set(nm,[]);byName.get(nm).push({k,uses:t.uses??1});}
    const variants=[...byName].filter(([,v])=>v.length>1);
    if(variants.length){
      console.log('\nsame name, drawn differently (one component; base = most used; diff <base> <other> to see what differs):');
      for(const [nm,v] of variants){v.sort((a,b)=>b.uses-a.uses);console.log(`  "${short(nm,20)}": base=${v[0].k}×${v[0].uses}  others: ${v.slice(1).map(x=>x.k+'×'+x.uses).join(' ')}`);}
    }
  }
}

// ---------- tokens ----------
function tokens(){
  // 数值都是设计稿像素：按屏宽提示倍率，免得把 2x 的值直接写进 CSS
  const widths=units().filter(e=>e.unit&&!isRef(e.unit)&&e.unit.tag!=='TEXT').map(e=>dim(e.unit).width).filter(w=>typeof w==='number'&&w>=320&&w<=1300);
  const mode=[...widths.reduce((m,w)=>m.set(w,(m.get(w)||0)+1),new Map())].sort((a,b)=>b[1]-a[1])[0]?.[0];
  if(mode){const scale=mode>=1100?3:mode>=700?2:1;
    console.log(scale>1?`note: 屏宽多为 ${mode}，是 ${scale}x 稿：下面的数值都要 ÷${scale} 再写成 CSS（同一文件里 375/390/414 宽的帧是 1x，单独判断）`:`note: 屏宽多为 ${mode}，1x 稿，数值直接用`);}
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
  const zero=r=>/^(0(px)?\s*)+$/.test(String(r).trim());
  walk(ast.nodes,n=>{if(n.borderRadius&&typeof n.borderRadius==='string'&&!zero(n.borderRadius))add('radius',n.borderRadius,1);});
  for(const [,b] of bodies())walk([b],n=>{if(n.borderRadius&&typeof n.borderRadius==='string'&&!zero(n.borderRadius))add('radius',n.borderRadius,1);});
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
      if(k==='args'||k==='params'){const x=a[k]||{},y=b[k]||{};for(const q of new Set([...Object.keys(x),...Object.keys(y)]))if(!same(x[q],y[q]))emit(`~ ${path} ${k}.${q}: ${x[q]===undefined?'∅':short(val(x[q]),60)} → ${y[q]===undefined?'∅':short(val(y[q]),60)}`);continue;}
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
  if(st.size){console.log('\nstyles:');for(const k of [...st].sort())console.log(k+' '+shortJSON(style(k)));}
}

// ---------- check ----------
function check(dirs){
  const units=[];let i;while((i=dirs.indexOf('--unit'))>=0){units.push(dirs[i+1]);dirs.splice(i,2);}
  const roots=units.length?units.map(locate):ast.nodes;
  // templates reachable from the chosen roots
  const used=new Set();const visit=n=>{if(!n)return;if(isRef(n)&&!used.has(n.t)){used.add(n.t);visit(T[n.t]?.body);}kids(n).forEach(visit);};roots.forEach(visit);
  const host=hostChrome();
  const hostTexts=new Set([...host.keys()].flatMap(k=>texts(T[k].body)));
  const allTexts=new Set(texts({children:roots,tag:'ROOT'}).filter(t=>!hostTexts.has(t)));
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


// ---------- local image references ----------
const LOCAL_IMAGE=/(^|[\/("'])([^\/("'\s]+\.(?:svg|png|jpe?g|webp|gif))(?=$|["')])/i;
function localImageRefs(){
  const out=[],seen=new Set();
  const visit=v=>{
    if(typeof v==='string'){if(/https?:\/\//.test(v))return;for(const m of v.matchAll(new RegExp(LOCAL_IMAGE.source,'gi'))){const full=v.slice(0,m.index+m[0].length).replace(/^.*url\(\s*["']?/,'').replace(/^["']/,'');const file=m[2];if(!seen.has(file)){seen.add(file);out.push({file,path:full});}}return;}
    if(Array.isArray(v))return v.forEach(visit);if(v&&typeof v==='object')Object.values(v).forEach(visit);};
  visit({n:ast.nodes,t:T,g:G});return out;
}
/** 图片目录：AST 里的本地路径相对 AST 文件 */
function imageDir(){
  const ref=localImageRefs()[0];if(!ref)return null;
  const rel=ref.path.slice(0,ref.path.length-ref.file.length);
  return join(file,'..',rel);
}

// ---------- assets ----------
// CLI saves images as <sha256>.<ext>; give them names from their Figma layers so code stays readable.
function assets(apply){
  const names=new Map(); // filename -> layer name
  // 本地图片引用（CLI --image-dir 改写后的相对路径）；远程链接不算
  const fileOf=v=>{if(typeof v!=='string'||/https?:\/\//.test(v))return null;const m=v.match(LOCAL_IMAGE);return m?m[2]:null;};
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
    for(const k of ['fills','maskFills'])if(typeof n[k]==='string'&&!fillOwner.has(n[k]))fillOwner.set(n[k],nm(n,p)+(k==='maskFills'?' mask':''));
  };
  walk(ast.nodes,(n,d,p)=>{visit(n,p);});for(const [,b] of bodies())walk([b],(n,d,p)=>{visit(n,p);});
  for(const [k,v] of Object.entries(G)){const s=JSON.stringify(v);const f=fileOf(s.replace(/\\"/g,'"'));if(f)note(f,fillOwner.get(k)||'image');}
  // also any file referenced but unnamed
  for(const ref of localImageRefs())if(!names.has(ref.file))names.set(ref.file,'image');
  const slug=s=>{const seg=String(s).split('/').map(x=>x.trim()).filter(Boolean);
    for(const part of [seg.at(-1),...seg.slice(0,-1).reverse()]){const clean=(part||'').toLowerCase().replace(/\b(frame|group|vector|rectangle|union|subtract|mask|layer)\b/g,' ').replace(/\b\d+\b/g,' ');
      const ascii=clean.replace(/[^a-z0-9]+/g,'-').replace(/^[-\d]+|-+$/g,'');if(ascii.length>=2)return ascii.slice(0,40);
      const cjk=clean.replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^[-\d]+|-+$/g,'');if(/[\u4e00-\u9fff]/.test(cjk))return cjk.slice(0,24);}
    return 'img';};
  // locate the image directory from the first local reference
  const dirOf=imageDir();
  if(!dirOf){console.log('no local images (fetch with --image-dir first)');return;}
  const read=f=>{try{return readFileSync(join(dirOf,f));}catch{return null;}};
  // byte-identical downloads collapse into one file
  const byHash=new Map(),dupOf=new Map();
  for(const f of names.keys()){const b=read(f);if(!b)continue;const h=createHash('sha1').update(b).digest('hex');if(byHash.has(h))dupOf.set(f,byHash.get(h));else byHash.set(h,f);}
  const info=f=>{
    const b=read(f);if(!b||!f.endsWith('.svg'))return {};
    const x=b.toString('utf8');
    const photo=/<image\b/.test(x)||b.length>150000;
    return {photo,...(photo?{}:plainShape(x)),broken:!balanced(x)};
  };
  const taken=new Map(),plan=[];
  for(const [f,name] of names){
    if(dupOf.has(f))continue;
    const ext=f.split('.').pop(),meta=info(f),sl=slug(name);
    // 旧版 CLI 用 URL 哈希命名；新版已按图层命名，保持原名
    if(!/^[a-f0-9]{64}\./.test(f)){taken.set(f,f);plan.push([f,f,name,meta]);continue;}
    let base=ext!=='svg'||meta.photo?(sl==='img'?'image':sl):(meta.shape?'shape-':/icon|logo/.test(sl)?'':'icon-')+sl;
    let out=base+'.'+ext;if(taken.has(out))out=base+'-'+f.slice(0,4)+'.'+ext;taken.set(out,f);plan.push([f,out,name,meta]);
  }
  const target=new Map(plan.map(([f,o])=>[f,o]));for(const [d,k] of dupOf)target.set(d,target.get(k));
  const shapes=plan.filter(p=>p[3].shape),broken=plan.filter(p=>p[3].broken);
  const pending=plan.filter(([f,o,,m])=>f!==o||m.broken).length+dupOf.size;
  if(!apply||!pending){
    for(const [f,o,n,m] of plan){if(f===o&&!m.shape&&!m.broken)continue;
      console.log((f===o?o:f.slice(0,10)+'… → '+o)+'  ("'+short(n,32)+'")'+(m.shape?'  [plain shape: '+m.shape+' → CSS]':'')+(m.broken?'  [malformed SVG]':''));}
    console.log(`${names.size} images, ${shapes.length} plain shapes (prefer CSS so states work)`+
      (pending?`; ${pending} files need renaming / dedupe / repair (older CLI) — run with --apply`:''));
    return;
  }
  let text=readFileSync(file,'utf8'),moved=0,fixed=0,removed=0;
  for(const [f,o,,m] of plan){
    const from=join(dirOf,f),to=join(dirOf,o);
    if(existsSync(from)&&!existsSync(to)){renameSync(from,to);moved++;}
    if(m.broken&&existsSync(to)){writeFileSync(to,repairSvg(readFileSync(to,'utf8')));fixed++;}
  }
  for(const d of dupOf.keys()){const p=join(dirOf,d);if(existsSync(p)){unlinkSync(p);removed++;}}
  for(const [f,o] of target)text=text.split(f).join(o);
  writeFileSync(file,text);
  console.log(`renamed ${moved}, merged ${removed} duplicates, repaired ${fixed} malformed SVGs in ${dirOf}; AST rewritten`);
  if(shapes.length)console.log(`plain shapes (likely button/card/tag backgrounds; prefer CSS so states work): ${shapes.map(p=>p[1]).join(', ')}`);
}

// 能直接用 CSS 画的图：只有一个图形、铺满整个画布（矩形 / 圆角矩形 / 椭圆），填充是纯色或渐变
function plainShape(svg){
  if(/<(filter|pattern|mask|clipPath|text|use)\b/.test(svg))return {};
  const size=svg.match(/<svg[^>]*?\bwidth="([\d.]+)"[^>]*?\bheight="([\d.]+)"/);if(!size)return {};
  const [W,H]=[+size[1],+size[2]];
  const shapes=[...svg.matchAll(/<(rect|path|circle|ellipse|polygon|line|polyline)\b([^>]*)>/g)];
  if(shapes.length!==1)return {};
  const [,tag,attrs]=shapes[0];const a=k=>attrs.match(new RegExp('\\s'+k+'="([^"]*)"'))?.[1];
  let box;
  if(tag==='rect')box=[+(a('x')||0),+(a('y')||0),+(a('width')||0),+(a('height')||0)];
  else if(tag==='circle'||tag==='ellipse'){const rx=+(a('r')||a('rx')||0),ry=+(a('r')||a('ry')||0);box=[+(a('cx')||0)-rx,+(a('cy')||0)-ry,2*rx,2*ry];}
  else if(tag==='path')box=pathBox(a('d')||'');
  if(!box||Math.abs(box[0])>1||Math.abs(box[1])>1||Math.abs(box[2]-W)>1||Math.abs(box[3]-H)>1)return {};
  const fill=a('fill')||'';const opacity=a('fill-opacity')||a('opacity');
  let paint;
  if(/^#[0-9a-f]{3,8}$/i.test(fill)||/^(white|black)$/i.test(fill))paint=fill.toUpperCase()+(opacity?' @'+opacity:'');
  else if(/^url\(#/.test(fill)&&/<(linear|radial)Gradient\b/.test(svg))paint='gradient';
  else return {};
  const outline=tag==='rect'?(a('rx')?`rounded r=${a('rx')}`:'rect'):tag==='path'?(/[CcQqAa]/.test(a('d')||'')?'rounded':'rect'):'ellipse';
  return {shape:`${outline} ${paint}`};
}
function pathBox(d){
  const tokens=d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g)||[];let i=0,cmd='',x=0,y=0,sx=0,sy=0;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;const mark=()=>{minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);};
  const num=()=>+tokens[i++];
  const arity={M:2,L:2,T:2,H:1,V:1,C:6,S:4,Q:4,A:7,Z:0};
  while(i<tokens.length){
    if(/[a-zA-Z]/.test(tokens[i]))cmd=tokens[i++];
    const C=cmd.toUpperCase(),rel=cmd!==C,n=arity[C];if(n===undefined)return null;
    if(C==='Z'){x=sx;y=sy;mark();continue;}
    const args=[];for(let k=0;k<n;k++){if(i>=tokens.length||/[a-zA-Z]/.test(tokens[i]))return null;args.push(num());}
    if(C==='H')x=(rel?x:0)+args[0];else if(C==='V')y=(rel?y:0)+args[0];
    else{const ex=args[n-2],ey=args[n-1];x=(rel?x:0)+ex;y=(rel?y:0)+ey;}
    if(C==='M'){sx=x;sy=y;cmd=rel?'l':'L';}
    mark();
  }
  return minX===Infinity?null:[minX,minY,maxX-minX,maxY-minY];
}
// Figma sometimes exports SVGs with unclosed <g> elements; browsers then refuse to render them.
function balanced(x){const st=[];for(const m of x.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)){if(m[0].startsWith('<?')||m[0].startsWith('<!'))continue;if(m[3])continue;if(m[1]){if(st.pop()!==m[2])return false;}else st.push(m[2]);}return st.length===0;}
function repairSvg(x){
  const st=[];let out='',last=0;
  for(const m of x.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)){
    if(m[3])continue;
    if(!m[1]){st.push(m[2]);continue;}
    if(st.includes(m[2])){let close='';while(st.length&&st.at(-1)!==m[2])close+='</'+st.pop()+'>';st.pop();
      out+=x.slice(last,m.index)+close;last=m.index;}
  }
  return out+x.slice(last);
}

// ---------- subset ----------
// 只保留选中的单元，以及它们用到的模板、样式、连线：先拉不带图片的 AST 决定范围，再只下这部分图片
function subset(specs,out){
  if(!specs.length||!out)throw new Error('subset needs unit ids and -o <file>');
  const units=specs.map(spec=>structuredClone(locate(spec)));
  const used=new Set();
  const visit=n=>{if(!n||typeof n!=='object')return;if(Array.isArray(n))return n.forEach(visit);
    if(typeof n.t==='string'&&!used.has(n.t)&&T[n.t]){used.add(n.t);visit(T[n.t].body);}
    Object.values(n).forEach(v=>{if(v&&typeof v==='object')visit(v);});};
  units.forEach(visit);
  const templates=Object.fromEntries([...used].map(k=>[k,T[k]]));
  const keys=new Set();const collect=v=>{if(typeof v==='string'){if(v in G&&!keys.has(v)){keys.add(v);const e=G[v];if(e&&typeof e.extends==='string')e.extends.split(',').map(x=>x.trim()).forEach(collect);}return;}
    if(Array.isArray(v))return v.forEach(collect);if(v&&typeof v==='object')Object.values(v).forEach(collect);};
  collect({units,templates});
  const globalStyles=Object.fromEntries(Object.keys(G).filter(k=>keys.has(k)).map(k=>[k,G[k]]));
  const ids=new Set();walk(units,n=>{if(n.id!==undefined)ids.add(String(n.id));});
  const connectors=(ast.connectors??[]).filter(c=>ids.has(String(c.from).split('/')[0])||ids.has(String(c.to).split('/')[0]));
  const result={name:ast.name,fileKey:ast.fileKey,...(connectors.length?{connectors}:{}),nodes:units,templates,globalStyles};
  writeFileSync(out,JSON.stringify(result));
  const remote=new Set(JSON.stringify(result).match(/https:\/\/[^"\\)]+/g)??[]);
  console.log(`subset: ${units.length} units, ${used.size}/${Object.keys(T).length} templates, ${keys.size}/${Object.keys(G).length} styles, ${remote.size} image links → ${out}`);
}

// ---------- prune ----------
// 生码完成后删掉代码里没有引用的图片（只动 AST 图片目录里的图片文件）
function prune(dirs,apply){
  const dir=imageDir();if(!dir)throw new Error('no local images in this AST');
  let code='';const exts=new Set(['.js','.jsx','.ts','.tsx','.vue','.svelte','.html','.css','.scss','.less','.json','.md','.mjs']);
  const rd=p=>{let s;try{s=statSync(p);}catch{return;}
    if(s.isDirectory()){if(/^(node_modules|\.git|dist|build|\.next|\.melonbuild)$/.test(basename(p)))return;for(const f of readdirSync(p))rd(join(p,f));}
    else if(exts.has(extname(p))&&s.size<2e6)code+=readFileSync(p,'utf8')+'\n';};
  for(const d of dirs.length?dirs:['.'])rd(d);
  const files=readdirSync(dir).filter(f=>/\.(svg|png|jpe?g|webp|gif)$/i.test(f));
  const unused=files.filter(f=>!code.includes(f)&&!code.includes(encodeURI(f)));
  const bytes=unused.reduce((s,f)=>s+statSync(join(dir,f)).size,0);
  console.log(`${files.length-unused.length}/${files.length} images referenced by code; ${unused.length} unused (${(bytes/1e6).toFixed(1)}MB) in ${dir}`);
  if(!apply){if(unused.length)console.log('  '+unused.slice(0,30).join('\n  ')+(unused.length>30?'\n  … +'+(unused.length-30):'')+'\nRun with --apply to delete them.');return;}
  for(const f of unused)unlinkSync(join(dir,f));
  console.log(`deleted ${unused.length} files`);
}

try{
  if(cmd==='outline')outline();
  else if(cmd==='assets')assets(rest.includes('--apply'));
  else if(cmd==='subset'){const out=opt('-o');subset(rest,out);}
  else if(cmd==='prune'){const apply=rest.includes('--apply');prune(rest.filter(x=>x!=='--apply'),apply);}
  else if(cmd==='tokens')tokens();
  else if(cmd==='show'){const d=Number(opt('--depth','99'));const ex=rest.includes('--expand');const specs=rest.filter(x=>x!=='--expand');
    if(!specs.length)throw new Error('show needs an id, template or path');show(specs.map(spec=>({spec,root:locate(spec)})),d,ex);}
  else if(cmd==='diff'){if(rest.length<2)throw new Error('diff needs two ids');diff(rest[0],rest[1]);}
  else if(cmd==='texts'){const n=rest[0]?locate(rest[0]):{tag:'ROOT',children:ast.nodes};console.log([...new Set(texts(n))].join('\n'));}
  else if(cmd==='check')check(rest);
  else {console.log(USAGE);process.exit(1);}
}catch(e){console.error('mb: '+e.message);process.exit(1);}
