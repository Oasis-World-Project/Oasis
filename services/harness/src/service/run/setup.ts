// 开工前的准备：每一轮都是新起的沙箱，上一轮起的进程（数据库、开发服务器……）不在了。工作目录或它下一层
// 目录里有 oasis-setup.sh 就在把话交给 AI 之前执行（各自在自己的目录里跑，有时限），退出码和输出的结尾
// 写在交给 AI 的话后面。脚本是用户项目里带的，或者 AI 自己写的（guide/playbooks/projects.md）。
import type { Sandbox } from '../../executor/executor.ts';

/** 在沙箱里找脚本、挨个执行，结果用 JSON 打到标准输出。输出先写进文件：脚本留在后台的进程不会拖住这一步 */
const SCRIPT = `const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const [root,seconds]=[process.argv[1],process.argv[2]];
const skip=new Set(['in','out','materials','node_modules']);
const dirs=[root,...fs.readdirSync(root,{withFileTypes:true}).filter((e)=>e.isDirectory()&&!e.name.startsWith('.')&&!skip.has(e.name)).map((e)=>path.join(root,e.name))];
const results=[];
for(const dir of dirs){
  if(!fs.existsSync(path.join(dir,'oasis-setup.sh')))continue;
  const log=path.join('/tmp','oasis-setup-'+results.length+'.log');
  const fd=fs.openSync(log,'w');
  const done=spawnSync('timeout',['-k','5',seconds,'sh','./oasis-setup.sh'],{cwd:dir,stdio:['ignore',fd,fd]});
  fs.closeSync(fd);
  results.push({path:path.relative(root,path.join(dir,'oasis-setup.sh')),code:done.status,output:fs.readFileSync(log,'utf8').slice(-3000)});
}
process.stdout.write(JSON.stringify(results));`;

interface SetupResult {
  path: string;
  code: number | null;
  output: string;
}

/**
 * 执行开工前的脚本，返回要接在交给 AI 的话后面的说明（事实：跑了哪个脚本、退出码、输出的结尾）；
 * 没有脚本、这个沙箱不支持（用户电脑上）就是空字符串。脚本没成功不算这一轮失败：告诉 AI，由它处理。
 */
export async function setupNote(sandbox: Sandbox, workdir: string, seconds: number) {
  if (!sandbox.run) return '';
  let results: SetupResult[];
  try {
    results = JSON.parse(await sandbox.run(['node', '-e', SCRIPT, workdir, String(seconds)]));
  } catch {
    return '';
  }
  return results
    .map(({ path, code, output }) => {
      const how =
        code === 0
          ? '退出码 0'
          : code === 124 || code === 137
            ? `超过 ${seconds} 秒被停下了`
            : `退出码 ${code ?? '未知'}`;
      const tail = output.trim();
      return `\n\n（开工前系统执行了 ${path}：${how}。${tail ? `输出的结尾：\n${tail}\n` : '没有输出。'}）`;
    })
    .join('');
}
