// 官网页：没登录的人在浏览器里直接打开网站时先看到它——Oasis 是什么、能拿来做什么、下载桌面版、
// 进入网页版。桌面版不经过这一页，带着目的地来的（比如邀请链接）也不经过，见 router.tsx 的 requireSession。
import { CHAT_AIS } from '@oasis/contracts/lineup';
import { Link } from '@tanstack/react-router';
import { FolderOpen, FolderSync, Package } from 'lucide-react';
import { AiAvatar } from '../ui/Avatar.tsx';
import { GroupPreview } from '../welcome/GroupPreview.tsx';

/** 安装包由线上的入口容器发（infra/images/entry/Caddyfile 的 /download）；本地开发时没有这个地址 */
const INSTALLER_URL = '/download/Oasis-Setup-x64.exe';

const AI_COUNT = CHAT_AIS.length;

const SCENES: { name: string; say: string; what: string; soon?: boolean }[] = [
  {
    name: '聊天',
    say: '今天有点累，陪我聊会儿吧',
    what: `${AI_COUNT} 家 AI 随你挑，各有各的脾气。同一段私聊一直接着聊，前面说过的它都知道。`,
  },
  {
    name: '桌游',
    say: '叫上三个 AI，来一局狼人杀',
    what: '在广场和 AI 们围坐一桌，玩 12 人狼人杀。',
    soon: true,
  },
  {
    name: '社交',
    say: '把小林拉进群，和 Kimi 一起商量周末去哪',
    what: '按账号 ID 加好友，人和 AI 在同一个群里聊。AI 们分得清谁在跟谁说话，会自己接话。',
  },
  {
    name: '语言',
    say: '用日语和我聊天，说错了就纠正我',
    what: '用你在学的语言聊天、改作文、讲语法；还能做一个会说这门语言的数字人，开口对练。',
  },
  {
    name: '办公',
    say: '把这三份 PDF 整理成一页周报，配张图表',
    what: '文档、表格、PPT、数据看板。做好了直接在画布里翻看和批注，哪里不满意圈出来让它改。',
  },
  {
    name: '创意',
    say: '给我家的猫写一首 30 秒的歌，再画个封面',
    what: '图片、视频、音乐、3D 模型、网页和小游戏。活儿大的话，群里的 AI 们会分工一起做。',
  },
];

const DESKTOP = [
  {
    icon: FolderOpen,
    title: '在你的电脑上干活',
    text: '选一个项目文件夹，AI 直接在里面读文件、改代码、跑程序。能动到哪里由你定：只读、只改这个文件夹，或者完全放开。',
  },
  {
    icon: FolderSync,
    title: '成果同步到电脑',
    text: '做好的文档、图片、视频存进你选的文件夹，后来改过的版本原地换新。',
  },
  {
    icon: Package,
    title: '装好就能用',
    text: '自带运行环境，不用另装 Node 之类的东西。',
  },
];

const DOWNLOAD_NOTE = 'Windows 10 / 11（64 位），约 200 MB。';
const BUTTON =
  'inline-flex h-12 items-center justify-center rounded-full px-7 text-[15px] font-medium no-underline';

function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-medium leading-none tracking-[-0.03em] ${className}`}>
      oasis
    </span>
  );
}

export function WelcomePage() {
  return (
    <div data-theme="site" className="min-h-screen bg-site-ground text-site-ink">
      <nav className="mx-auto flex h-[72px] max-w-[1240px] items-center justify-between px-6 lg:px-10">
        <Wordmark className="text-[24px]" />
        <div className="flex items-center gap-1 text-[14px]">
          <a
            href="#scenes"
            className="hidden rounded-full px-4 py-2.5 text-site-ink no-underline hover:bg-site-line md:inline"
          >
            能做什么
          </a>
          <a
            href="#desktop"
            className="hidden rounded-full px-4 py-2.5 text-site-ink no-underline hover:bg-site-line md:inline"
          >
            桌面版
          </a>
          <Link
            to="/login"
            className="rounded-full px-4 py-2.5 text-site-ink no-underline hover:bg-site-line"
          >
            进入网页版
          </Link>
        </div>
      </nav>

      <header className="mx-auto grid max-w-[1240px] items-center gap-12 px-6 pb-12 pt-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:px-10 lg:pt-10">
        <div className="flex flex-col gap-7">
          {/* 两行各自不断开（「方」单独掉到下一行很难看），字号随窗口宽度在 40–60px 之间变 */}
          <h1 className="m-0 flex flex-col text-[clamp(40px,4.2vw,60px)] font-light leading-[1.15] tracking-[-0.02em]">
            <span className="whitespace-nowrap">人和 AI</span>
            <span className="whitespace-nowrap">待在一起的地方</span>
          </h1>
          <p className="m-0 max-w-[30em] text-[17px] leading-[1.8] text-site-muted">
            这里有 Claude、GPT、DeepSeek、Kimi 等 {AI_COUNT} 家
            AI。和它们私聊，拉它们进群，叫上朋友一起玩；要做文档、图片、视频、网页，交给它们分工去做。
          </p>
          <div className="flex flex-wrap gap-3">
            <a href={INSTALLER_URL} download className={`${BUTTON} bg-site-ink text-site-ground`}>
              下载 Windows 版
            </a>
            <Link to="/login" className={`${BUTTON} border-[1.5px] border-site-ink text-site-ink`}>
              进入网页版
            </Link>
          </div>
          <p className="m-0 text-[13px] text-site-muted">{DOWNLOAD_NOTE}第一次登录送 $30 额度。</p>
        </div>
        <GroupPreview />
      </header>

      <section
        aria-label={`可以挑的 ${AI_COUNT} 家 AI`}
        className="mx-auto max-w-[1240px] px-6 pb-20 lg:px-10"
      >
        <ul className="m-0 flex list-none flex-wrap justify-center gap-x-2 gap-y-5 lg:justify-between border-t border-site-line p-0 pt-8">
          {CHAT_AIS.map((a) => (
            <li key={a.key} className="flex w-[64px] flex-col items-center gap-2">
              <AiAvatar mono={a.mono} glow={a.glow} size={40} />
              <span className="text-center text-[12px] text-site-muted">{a.name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section id="scenes" className="mx-auto max-w-[1240px] scroll-mt-6 px-6 pb-28 lg:px-10">
        <h2 className="m-0 text-[34px] font-light tracking-[-0.01em] lg:text-[40px]">
          可以拿它做什么
        </h2>
        <p className="m-0 mt-3 text-[16px] text-site-muted">
          几句你可以直接说的话，和接下来会发生什么。
        </p>
        <ul className="m-0 mt-10 list-none p-0">
          {SCENES.map((s) => (
            <li
              key={s.name}
              className="grid gap-4 border-t border-site-line py-8 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-10"
            >
              <h3 className="m-0 flex items-baseline gap-3 text-[28px] font-light">
                {s.name}
                {s.soon && (
                  <span className="rounded-full border border-site-line px-2.5 py-0.5 text-[12px] font-normal text-site-muted">
                    即将开放
                  </span>
                )}
              </h3>
              <p className="bubble-out m-0 w-fit max-w-full bg-solid px-5 py-3 text-[15px] leading-[1.6] text-on-solid">
                {s.say}
              </p>
              <p className="m-0 text-[15px] leading-[1.8] text-site-muted">{s.what}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="desktop" className="scroll-mt-6 bg-site-deep text-site-on-deep">
        <div className="mx-auto grid max-w-[1240px] gap-14 px-6 py-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:px-10">
          <div className="flex flex-col gap-6">
            <h2 className="m-0 text-[34px] font-light leading-[1.25] lg:text-[40px]">
              下载桌面版，
              <br />
              功能更全
            </h2>
            <p className="m-0 max-w-[28em] text-[16px] leading-[1.8] text-site-on-deep-muted">
              网页版不用安装，AI
              在云端的电脑上干活，聊天、拉群、做东西都可以。桌面版在这些之外，还能让 AI
              用上你自己的电脑。
            </p>
            <div className="flex flex-col gap-3">
              <a
                href={INSTALLER_URL}
                download
                className={`${BUTTON} w-fit bg-site-on-deep text-site-deep`}
              >
                下载 Windows 版
              </a>
              <p className="m-0 max-w-[30em] text-[13px] leading-[1.8] text-site-on-deep-muted">
                {DOWNLOAD_NOTE}现在的安装包还没有签名，安装时 Windows
                会提示「未知发布者」：点「更多信息」，再点「仍要运行」。
              </p>
            </div>
          </div>
          <ul className="m-0 flex list-none flex-col p-0">
            {DESKTOP.map(({ icon: Icon, title, text }) => (
              <li
                key={title}
                className="flex gap-5 border-t border-site-on-deep/15 py-7 first:border-t-0 first:pt-0"
              >
                <Icon size={24} strokeWidth={1.5} aria-hidden="true" className="mt-1 shrink-0" />
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-[19px] font-medium">{title}</h3>
                  <p className="m-0 text-[15px] leading-[1.8] text-site-on-deep-muted">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-4 px-6 py-10 text-[13px] text-site-muted lg:px-10">
        <Wordmark className="text-[18px] text-site-ink" />
        <span>还在开发中的版本，欢迎试用。</span>
      </footer>
    </div>
  );
}
