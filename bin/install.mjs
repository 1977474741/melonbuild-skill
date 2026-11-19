#!/usr/bin/env node
// 把 MelonBuild skill 装进 AI 编程工具的 skills 目录。
import {cpSync,existsSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(readFileSync(join(source,'package.json'),'utf8')).version;
const FILES=['SKILL.md','references','scripts'];
const args=process.argv.slice(2);
const usage=`MelonBuild skill ${version}

用法：
  npx melonbuild-skill                 安装到 ~/.claude/skills/melonbuild（所有项目可用）
  npx melonbuild-skill --project       安装到当前项目的 .claude/skills/melonbuild
  npx melonbuild-skill --dir <目录>    安装到指定的 skills 目录下的 melonbuild/
  npx melonbuild-skill --help

已安装时会更新到当前版本。skill 依赖 melonbuild CLI：npm i -g melonbuild-cli`;

if(args.includes('--help')||args.includes('-h')){console.log(usage);process.exit(0);}
let base;
const at=args.indexOf('--dir');
if(at>=0){if(!args[at+1]){console.error('--dir 需要一个目录。\n\n'+usage);process.exit(1);}base=resolve(args[at+1]);}
else if(args.includes('--project'))base=resolve('.claude','skills');
else base=join(homedir(),'.claude','skills');
const unknown=args.filter((a,i)=>!['--project','--dir'].includes(a)&&!(at>=0&&i===at+1));
if(unknown.length){console.error('未知参数：'+unknown.join(' ')+'\n\n'+usage);process.exit(1);}

const target=join(base,'melonbuild');
// 目标目录已存在但不是本 skill 时不覆盖，避免误删用户自己的文件
if(existsSync(target)){
  const skill=join(target,'SKILL.md');
  const ours=existsSync(skill)&&/^name:\s*melonbuild\s*$/m.test(readFileSync(skill,'utf8'));
  if(!ours){console.error(`${target} 已存在，且不是 MelonBuild skill，未做任何改动。`);process.exit(1);}
  for(const f of FILES)rmSync(join(target,f),{recursive:true,force:true});
}
mkdirSync(target,{recursive:true});
for(const f of FILES)cpSync(join(source,f),join(target,f),{recursive:true});
console.log(`MelonBuild skill ${version} 已安装到 ${target}`);
console.log('在 Claude Code 里给出 Figma 链接并说明需求即可使用；skill 依赖 melonbuild CLI（npm i -g melonbuild-cli）。');
