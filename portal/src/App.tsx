import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FocusEventHandler, ReactEventHandler } from 'react';

/* ============================================================
   BRAND
   ============================================================ */
const BRAND = 'Prompt Vault';
const TAGLINE = '解锁 Prompt › 灵感库';

/* ============================================================
   HERO BACKGROUND (沉浸感背景)
   保留用户指定的远端素材，同时用 CSS 光场做兜底，避免图片加载失败时页面失去质感。
   ============================================================ */
const PORTAL_BG =
  'https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779707217/image_1_vdzwae.png';
const CURTAIN_LEFT =
  'https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706559/curtain_left_znkmva.png';
const CURTAIN_RIGHT =
  'https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706564/curtain_right_paeyym.png';
const WORLD_BG =
  'https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706392/image_2_gkcdlx.png';
const BOTTOM_CLOUDS =
  'https://res.cloudinary.com/dy5er7kv5/image/upload/q_auto/f_auto/v1779706555/bottom_clouds_xskut6.png';
const TUTORIAL_URL = 'https://v.douyin.com/0T-aHQW3MwA/';
const LOGIN_HERO_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260306_115329_5e00c9c5-4d69-49b7-94c3-9c31c60bb644.mp4';

const CARD_IMAGES = [
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260525_160507_2ccbb4eb-1469-484f-af25-59168ad9a233.png&w=1280&q=85',
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260525_160644_072a7f68-a101-4ded-a332-7d37707dbdd1.png&w=1280&q=85',
  'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_38xzZboKViGWJOttwIXH07lWA1P%2Fhf_20260525_160706_1c153d04-0dfb-4ac9-a4ef-e74f301c329c.png&w=1280&q=85',
];

/* 营销价值卡 — 弧形展示 (强调 "物超所值") */
const ARC_CARDS = [
  { title: '动效画廊',  desc: '253 套 React + Tailwind 动效成品，撷来即用',           color: '#f3cdd6' },
  { title: '沉浸叙事',  desc: 'GSAP / Framer Motion 滚动驱动叙事完整提示词',          color: '#dcedc2' },
  { title: '盲盒灵感',  desc: '不定期更新 10 余枚原创 UI 灵感，开之愈有，愈开愈喜',   color: '#c3e3f4' },
  { title: '可商用',    desc: '悉数可入商用之作，省却两百余时辰设计之功',           color: '#f0e4c0' },
  { title: '逐字可跑',  desc: '粘入 Cursor / Claude，顷刻生得同款页面',             color: '#dcd2f2' },
  { title: '持续更新',  desc: '新词永久解锁，与设计新潮并驱争先',                   color: '#f3cdd6' },
  { title: '分类齐全',  desc: 'Hero · 落地页 · 移动应用 · SaaS · 电商，靡不毕备', color: '#c3e3f4' },
  { title: '真机演示',  desc: '每词附 Mux 视频预览，所见即所得',                     color: '#f0e4c0' },
  { title: '永久解锁',  desc: '一朝入手，253 套暨日后新词，皆得永享',                color: '#dcedc2' },
];

/* ============================================================
   HELPERS
   ============================================================ */
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (val: number, min: number, max: number) => Math.min(Math.max(val, min), max);
const hideBrokenDecorImage: ReactEventHandler<HTMLImageElement> = (event) => {
  event.currentTarget.style.display = 'none';
};

const MAG = { world: 6, clouds: 9, portal: 7, curtainL: 14, curtainR: 14 } as const;

const bloomLogoPaths = [
  'M48.4404 17.6588C47.7017 15.3617 46.2569 13.3584 44.3131 11.9362C42.3693 10.5141 40.0265 9.74617 37.6207 9.74268H37.0462C37.1235 10.2805 37.164 10.8231 37.1676 11.3665C37.1628 14.3622 36.0924 17.2579 34.1489 19.5323C32.2054 21.8066 29.5166 23.3102 26.5664 23.7724C26.6392 24.0729 26.7121 24.3733 26.8092 24.6655C26.9904 25.2224 27.2122 25.7651 27.4728 26.2894L27.4728 26.3543C27.5942 26.5898 27.7236 26.8252 27.8612 27.0526L27.9178 27.15C28.3242 27.8128 28.796 28.433 29.3259 29.0011L29.5687 29.2609L29.9652 29.6263C30.0866 29.74 30.2161 29.8536 30.3537 29.9592L30.7098 30.2515C30.8797 30.3814 31.0577 30.5032 31.2358 30.625L31.5595 30.8523C31.8508 31.0309 32.1502 31.2095 32.4577 31.3638C33.787 32.0468 35.2378 32.4594 36.7266 32.5778C38.2154 32.6963 39.7129 32.5182 41.1329 32.0539C41.4083 31.9667 41.6785 31.8637 41.9421 31.7454C44.6033 30.6611 46.7546 28.6033 47.961 25.9882C49.1674 23.3731 49.3387 20.3958 48.4404 17.6588Z',
  'M41.4966 33.1341C40.2425 33.5456 38.9316 33.7566 37.6122 33.7593C35.2977 33.7531 33.0303 33.1034 31.0617 31.8822C29.0931 30.6611 27.5005 28.9163 26.4607 26.8418C26.1937 27.0042 25.9428 27.1747 25.6515 27.3614C25.1901 27.702 24.7546 28.0765 24.3486 28.4819L24.3 28.5306C24.1058 28.7173 23.9278 28.9122 23.7497 29.1151L23.685 29.1963C23.1783 29.7906 22.7336 30.4354 22.3578 31.1206C22.3012 31.2261 22.2445 31.3235 22.196 31.4291C22.1474 31.5346 22.0341 31.7538 21.9613 31.9162C21.8885 32.0786 21.8237 32.2329 21.7671 32.3952C21.7104 32.5576 21.6538 32.6794 21.6052 32.8256C21.5567 32.9717 21.4677 33.2315 21.411 33.4345C21.3544 33.6375 21.3382 33.6699 21.3139 33.7917C21.2236 34.1255 21.1534 34.4644 21.1035 34.8066C20.8672 36.2866 20.9251 37.7989 21.2737 39.2564C21.6223 40.7139 22.2548 42.0879 23.1347 43.2992C23.2966 43.5184 23.4746 43.7376 23.6526 43.9406C25.3534 46.0837 27.7685 47.5385 30.4534 48.0372C33.1384 48.045 35.9125 48.045 38.2653 46.6547C40.6181 45.2645 42.3913 43.0685 43.2586 40.4708C44.1259 37.8732 44.029 35.0487 42.9856 32.517C42.5042 32.7574 42.0067 32.9636 41.4966 33.1341Z',
  'M20.0045 34.6197C20.4175 31.9862 21.6629 29.5556 23.5571 27.686C23.3224 27.4912 23.0796 27.2882 22.8287 27.1096C21.2988 25.9892 19.5119 25.2743 17.6334 25.0311H17.3987C16.9941 24.9905 16.5894 24.958 16.1686 24.958C14.3714 24.962 12.6002 25.3895 10.9978 26.206C9.39542 27.0226 8.00658 28.2053 6.9432 29.659C6.78135 29.8863 6.63568 30.1217 6.49002 30.3572C5.03583 32.6434 4.4443 35.3759 4.82225 38.0613C5.2002 40.7467 6.52271 43.208 8.55098 45.0008C10.5793 46.7937 13.1796 47.7998 15.8825 47.8376C18.5854 47.8754 21.2127 46.9424 23.29 45.207C22.9121 44.8221 22.5632 44.4096 22.2461 43.9729C21.2738 42.6404 20.575 41.1275 20.1902 39.5219C19.8054 37.9163 19.7423 36.25 20.0045 34.6197Z',
  'M6.01393 28.9525C7.76739 26.527 10.3287 24.8119 13.234 24.1178C16.1392 23.4238 19.1961 23.7967 21.8509 25.169C21.9723 24.8848 22.0856 24.6006 22.1827 24.3002C22.7183 22.6659 22.8815 20.9318 22.6602 19.2258V18.9903C22.6602 18.7955 22.5873 18.6006 22.5469 18.4139C22.5064 18.2271 22.4821 18.1054 22.4417 17.9592C22.4012 17.8131 22.3608 17.6426 22.3122 17.4802C22.2636 17.3178 22.1827 17.0905 22.118 16.8956C22.0532 16.7008 22.029 16.652 21.9804 16.5384C21.8586 16.2165 21.7181 15.902 21.5596 15.5966C20.8885 14.2565 19.9583 13.0639 18.8232 12.0881C17.6881 11.1124 16.3708 10.3731 14.948 9.91321C14.6972 9.83202 14.4544 9.76706 14.2035 9.71023C13.2994 9.47628 12.3696 9.35628 11.4359 9.35299C8.9636 9.30745 6.54433 10.0747 4.54726 11.5375C2.55019 13.0004 1.08498 15.0786 0.375205 17.4551C-0.334567 19.8315 -0.249922 22.3757 0.616224 24.6993C1.48237 27.023 3.08245 28.9986 5.17231 30.3246C5.42183 29.8488 5.70301 29.3904 6.01393 28.9525Z',
  'M22.5278 15.0688C23.735 17.4435 24.1546 20.143 23.7255 22.7738C24.025 22.7738 24.3325 22.8225 24.6481 22.8225C25.2227 22.8148 25.796 22.766 26.3637 22.6764C28.9618 22.273 31.3392 20.9756 33.0885 19.0065L33.2585 18.8198C33.4041 18.6493 33.5417 18.4707 33.6793 18.2839C33.8169 18.0972 33.833 18.0891 33.9059 17.9835C33.9787 17.878 34.1406 17.6425 34.2458 17.472C34.351 17.3015 34.4076 17.2122 34.4804 17.0823C34.5533 16.9524 34.6666 16.7575 34.7475 16.587C34.8284 16.4165 34.9013 16.2785 34.9741 16.1243C35.0469 15.97 35.1117 15.8076 35.1845 15.6452C35.2573 15.4829 35.314 15.2961 35.3706 15.1175C35.4273 14.9389 35.4839 14.8008 35.5325 14.6466C35.581 14.4923 35.6377 14.2488 35.6862 14.0458C35.7348 13.8428 35.7591 13.7535 35.7833 13.6073C35.8076 13.4612 35.8643 13.1364 35.8966 12.8929C35.929 12.6493 35.8966 12.6493 35.9452 12.5194C35.9452 12.154 36.0018 11.7887 36.0018 11.4071V10.5952C35.8453 7.88465 34.727 5.31985 32.8491 3.36487C30.9712 1.40989 28.4579 0.193859 25.7639 -0.0631835C23.0699 -0.320226 20.3731 0.398699 18.1616 1.96351C15.9501 3.52831 14.37 5.83563 13.707 8.46797C14.2332 8.56239 14.7523 8.69259 15.2608 8.85768C16.8205 9.36099 18.2656 10.1689 19.5128 11.2349C20.76 12.3008 21.7847 13.6038 22.5278 15.0688Z',
];

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

/* ============================================================
   BRAND DOT
   ============================================================ */
function BrandDot() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: "'Viaoda Libre', 'PingFang SC', serif",
        fontSize: 24,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        color: '#fff',
      }}
    >
      <BloomLogo size={36} />
      <span>Prompt Vault</span>
    </span>
  );
}

function BloomLogo({ size = 40 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 49 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      aria-hidden="true"
      style={{ flex: '0 0 auto', filter: 'drop-shadow(0 10px 24px rgba(203,141,255,0.2))' }}
    >
      <g clipPath="url(#prompt-vault-bloom-logo)">
        {bloomLogoPaths.map((path, index) => (
          <path key={index} d={path} fill="white" />
        ))}
      </g>
      <defs>
        <clipPath id="prompt-vault-bloom-logo">
          <rect width="49" height="48" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

function BloomCanvasBackdrop({ scrollProgress }: { scrollProgress: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const dots = Array.from({ length: 72 }, (_, i) => ({
      seed: i * 37.17,
      radius: 90 + (i % 8) * 24,
      speed: 0.00018 + (i % 5) * 0.000035,
      alpha: 0.08 + (i % 6) * 0.018,
    }));

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const render = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, '#020103');
      bg.addColorStop(0.46, '#09050d');
      bg.addColorStop(1, '#000000');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      const drift = scrollProgress * 160;
      dots.forEach((dot, index) => {
        const t = time * dot.speed + dot.seed;
        const x = width * (0.5 + Math.cos(t * 0.88) * (0.24 + (index % 3) * 0.04));
        const y = height * (0.5 + Math.sin(t * 1.13) * (0.28 + (index % 4) * 0.025)) - drift;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, dot.radius);
        const hue = index % 3 === 0 ? '203,141,255' : index % 3 === 1 ? '99,102,241' : '244,114,182';
        grd.addColorStop(0, `rgba(${hue},${dot.alpha})`);
        grd.addColorStop(0.46, `rgba(${hue},${dot.alpha * 0.34})`);
        grd.addColorStop(1, `rgba(${hue},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, dot.radius, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 9; i++) {
        const y = height * (0.12 + i * 0.11) + Math.sin(time * 0.00035 + i) * 16 - scrollProgress * 90;
        ctx.beginPath();
        for (let x = -40; x <= width + 40; x += 40) {
          const wave = Math.sin(x * 0.008 + time * 0.00055 + i) * (18 + i * 1.6);
          if (x === -40) ctx.moveTo(x, y + wave);
          else ctx.lineTo(x, y + wave);
        }
        ctx.stroke();
      }

      raf = requestAnimationFrame(render);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(render);
    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
    };
  }, [scrollProgress]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: '-5%',
        width: '110%',
        height: '110%',
        pointerEvents: 'none',
        userSelect: 'none',
        transform: `translate3d(0, ${scrollProgress * -22}px, 0) scale(${1 + scrollProgress * 0.04})`,
        transition: 'transform .4s cubic-bezier(.15,.85,.35,1)',
        zIndex: 0,
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(circle at 52% 44%, transparent 0 32%, rgba(0,0,0,0.34) 67%, rgba(0,0,0,0.82) 100%)',
        }}
      />
    </div>
  );
}

function AmbientBackdrop({ scrollProgress }: { scrollProgress: number }) {
  const fade = clamp(1 - scrollProgress / 0.72, 0.18, 1);
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        background:
          'radial-gradient(circle at 20% 22%, rgba(203,141,255,0.24), transparent 30%), radial-gradient(circle at 72% 48%, rgba(99,102,241,0.20), transparent 34%), radial-gradient(circle at 55% 112%, rgba(244,114,182,0.16), transparent 38%)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: '-12%',
          opacity: fade,
          background:
            'linear-gradient(115deg, rgba(255,255,255,0.08) 0 1px, transparent 1px 18px), linear-gradient(245deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 22px)',
          maskImage: 'radial-gradient(circle at center, black 0%, transparent 72%)',
          WebkitMaskImage: 'radial-gradient(circle at center, black 0%, transparent 72%)',
          transform: `translateY(${scrollProgress * -60}px) rotate(${scrollProgress * 4}deg)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: '52vw',
          height: '52vw',
          minWidth: 420,
          minHeight: 420,
          right: '-12vw',
          top: '12vh',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '50%',
          boxShadow: 'inset 0 0 80px rgba(203,141,255,0.12), 0 0 120px rgba(99,102,241,0.16)',
          opacity: fade,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.22,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'linear-gradient(to bottom, transparent, black 16%, black 78%, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 16%, black 78%, transparent)',
        }}
      />
    </div>
  );
}

/* ============================================================
   SCROLL CHEVRON (animation: bobUp)
   ============================================================ */
function ScrollChevron() {
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: '50%',
        border: '1.5px solid rgba(255,255,255,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'bobUp 1.8s ease-in-out infinite',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

function TutorialBadge({
  onClick,
  compact = false,
}: {
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 7 : 9,
        padding: compact ? '10px 14px' : '13px 20px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.3)',
        background: 'linear-gradient(135deg, rgba(99,102,241,0.92), rgba(244,114,182,0.9))',
        color: '#fff',
        fontFamily: "'Imprima', 'PingFang SC', sans-serif",
        fontSize: compact ? 12.5 : 13.5,
        fontWeight: 700,
        letterSpacing: '0.04em',
        cursor: 'pointer',
        boxShadow:
          '0 18px 42px -14px rgba(244,114,182,0.84), 0 0 24px rgba(99,102,241,0.32), 0 0 0 1px rgba(255,255,255,0.1) inset',
        whiteSpace: 'nowrap',
        animation: 'tutorialBadgeFloat 2.8s ease-in-out infinite, tutorialBadgeGlow 2.2s ease-in-out infinite',
        transformOrigin: 'center',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: compact ? 22 : 26,
          height: compact ? 22 : 26,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.18)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: '0 0 18px rgba(255,255,255,0.18), 0 0 0 1px rgba(255,255,255,0.08) inset',
          animation: 'tutorialBadgeCoreGlow 2.1s ease-in-out infinite',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
      <span>使用教程</span>
    </button>
  );
}

/* ============================================================
   NAV
   ============================================================ */
function Nav({
  isMobile,
  onJumpToLogin,
  onOpenTutorial,
}: {
  isMobile: boolean;
  onJumpToLogin: () => void;
  onOpenTutorial: () => void;
}) {
  if (isMobile) {
    return (
      <nav
        style={{
          position: 'absolute',
          top: 24,
          left: 24,
          right: 24,
          zIndex: 50,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <BrandDot />
        <a
          href="#login"
          onClick={(e) => { e.preventDefault(); onJumpToLogin(); }}
          style={navLinkStyle(12)}
        >登录</a>
      </nav>
    );
  }
  return (
    <nav
      style={{
        position: 'absolute',
        top: 'clamp(24px, 3vw, 48px)',
        left: 'clamp(24px, 3vw, 48px)',
        right: 'clamp(24px, 3vw, 48px)',
        zIndex: 50,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <BrandDot />
      <div style={{ display: 'flex', gap: 0, alignItems: 'center' }}>
        <a href="#vault" style={navLinkStyle(13)}>灵感库</a>
        <a href="#value" style={navLinkStyle(13)}>会员权益</a>
        <button
          type="button"
          onClick={onOpenTutorial}
          style={{ ...navLinkStyle(13), border: 0, cursor: 'pointer' }}
        >教程</button>
        <a
          href="#login"
          onClick={(e) => { e.preventDefault(); onJumpToLogin(); }}
          style={{ ...navLinkStyle(13), cursor: 'pointer' }}
        >解锁 →</a>
      </div>
    </nav>
  );
}

function navLinkStyle(fontSize: number): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 36,
    padding: 'clamp(8px,0.7vw,12px) clamp(16px,1.3vw,24px)',
    borderRadius: 8,
    background: '#fff',
    fontFamily: "'Imprima', 'PingFang SC', sans-serif",
    fontSize,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: '#0b0b0f',
    opacity: 1,
    textDecoration: 'none',
    boxShadow: '0 14px 34px rgba(0,0,0,0.18)',
  };
}

/* ============================================================
   SCENE 1 UI BLOCKS
   ============================================================ */
function Scene1HeadingDesktop() {
  return (
    <div
      style={{
        position: 'absolute',
        left: 'clamp(28px, 3vw, 52px)',
        bottom: 'clamp(32px, 5vw, 72px)',
        width: 'min(520px, 35vw)',
        minWidth: 420,
        padding: 'clamp(34px, 3.2vw, 54px)',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(255,255,255,0.14)',
        backdropFilter: 'blur(42px) saturate(130%)',
        WebkitBackdropFilter: 'blur(42px) saturate(130%)',
        boxShadow: '0 30px 70px rgba(0,0,0,0.38)',
        color: '#fff',
      }}
    >
      <div
        style={{
          fontFamily: "'Viaoda Libre', serif",
          fontSize: 'clamp(48px, 5.4vw, 78px)',
          lineHeight: 1.04,
          letterSpacing: '-0.01em',
        }}
      >
        把灵感，变成可运行的界面
      </div>
      <p
        style={{
          marginTop: 18,
          fontFamily: "'Imprima', 'PingFang SC', sans-serif",
          fontSize: 15,
          lineHeight: 1.7,
          color: 'rgba(255,255,255,0.68)',
          maxWidth: 380,
        }}
      >
        精选 MotionSites 动效提示词、AI 灵感库与图像/视频生成灵感，适合 Cursor、Claude、Vite、React 快速落地。
      </p>
      <div
        style={{
          marginTop: 22,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderRadius: 999,
          background: '#CB8DFF',
          border: '1px solid rgba(255,255,255,0.18)',
          color: '#fff',
          fontFamily: "'Imprima', 'PingFang SC', sans-serif",
          fontSize: 12,
          letterSpacing: '0.08em',
          boxShadow: '0 18px 44px rgba(203,141,255,0.34)',
        }}
      >
        <span>253+ 套已整理提示词</span>
      </div>
      <button
        type="button"
        onClick={() => {
          const total = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo({ top: total * 0.84, behavior: 'smooth' });
        }}
        aria-label="进入登录"
        style={{
          position: 'absolute',
          right: 'calc(-1 * (clamp(80px,7vw,112px) / 2))',
          bottom: 'clamp(20px,2.5vw,40px)',
          width: 'clamp(80px,7vw,112px)',
          height: 'clamp(80px,7vw,112px)',
          borderRadius: '50%',
          border: 0,
          background: '#CB8DFF',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 18px 44px rgba(203,141,255,0.34)',
          pointerEvents: 'auto',
        }}
      >
        <svg width="44" height="28" viewBox="0 0 40 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M29.5 4.5L37 12m0 0l-7.5 7.5M37 12H3" />
        </svg>
      </button>
    </div>
  );
}

function Scene1HeadingMobile() {
  return (
    <div
      style={{
        width: 'calc(100vw - 48px)',
        padding: '26px 22px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(255,255,255,0.14)',
        backdropFilter: 'blur(34px) saturate(130%)',
        WebkitBackdropFilter: 'blur(34px) saturate(130%)',
        boxShadow: '0 24px 60px rgba(0,0,0,0.34)',
        textAlign: 'left',
        color: '#fff',
      }}
    >
      <div
        style={{
          fontFamily: "'Viaoda Libre', serif",
          fontSize: 'clamp(38px, 12vw, 54px)',
          letterSpacing: '-0.01em',
          lineHeight: 1.05,
        }}
      >
        把灵感，变成界面
      </div>
      <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.65, color: 'rgba(255,255,255,0.68)' }}>
        MotionSites 动效提示词、AI 灵感库、IMG AI 与 VID AI，一处进入。
      </p>
      <button
        type="button"
        onClick={() => {
          const total = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo({ top: total * 0.84, behavior: 'smooth' });
        }}
        aria-label="进入登录"
        style={{
          position: 'absolute',
          right: -16,
          bottom: -32,
          width: 64,
          height: 64,
          borderRadius: '50%',
          border: 0,
          background: '#CB8DFF',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 18px 44px rgba(203,141,255,0.34)',
          pointerEvents: 'auto',
        }}
      >
        <svg width="38" height="22" viewBox="0 0 40 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M29.5 4.5L37 12m0 0l-7.5 7.5M37 12H3" />
        </svg>
      </button>
    </div>
  );
}

function Scene1SubtextDesktop() { return null; }
function Scene1SubtextMobile() {
  return (
    <p
      style={{
        fontFamily: "'Imprima', 'PingFang SC', sans-serif",
        fontSize: 14,
        lineHeight: 1.6,
        color: 'rgba(255,255,255,0.72)',
        maxWidth: 280,
        textAlign: 'center',
        margin: '0 auto',
      }}
    >
      向下滚动进入登录或注册。
    </p>
  );
}

/* ---- Card (shared by mobile single card and desktop 3-card block) ---- */
type CardKind = 'play' | 'number';

function PlayButton({ size = 26 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={size * 0.4}
        height={size * 0.4}
        viewBox="0 0 24 24"
        fill="#1a1a1a"
        style={{ marginLeft: 2 }}
      >
        <path d="M8 5v14l11-7z" />
      </svg>
    </div>
  );
}

function ShowcaseCard({
  size,
  radius,
  image,
  kind,
  delay,
}: {
  size: number;
  radius: number;
  image: string;
  kind: CardKind;
  delay: number;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        overflow: 'hidden',
        position: 'relative',
        backgroundImage: `url(${image})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
        flexShrink: 0,
        opacity: 0,
        transform: 'translateY(20px)',
        animation: `scene1CardIn 0.9s ease forwards ${delay}s`,
      }}
    >
      {/* gradient overlay (bottom 60%) */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '60%',
          background:
            'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 50%, transparent 100%)',
          pointerEvents: 'none',
        }}
      />
      {/* backdrop blur layer */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '44%',
          backdropFilter: 'blur(0px)',
          WebkitBackdropFilter: 'blur(0px)',
          background:
            'linear-gradient(to top, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.05) 60%, transparent 100%)',
          maskImage: 'linear-gradient(to top, black 0%, black 60%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to top, black 0%, black 60%, transparent 100%)',
          pointerEvents: 'none',
        }}
      />
      {/* bottom content */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: '#fff',
        }}
      >
        {kind === 'play' ? (
          <>
            <PlayButton size={size >= 150 ? 30 : 26} />
            <span style={{ fontFamily: "'Imprima', sans-serif", fontSize: size >= 150 ? 18 : 13 }}>
              View Reel
            </span>
          </>
        ) : (
          <>
            <span
              style={{
                fontFamily: "'Viaoda Libre', serif",
                fontSize: size >= 150 ? 36 : 28,
                color: '#fff',
                lineHeight: 1,
              }}
            >
              32
            </span>
            <span
              style={{
                fontFamily: "'Imprima', sans-serif",
                fontSize: size >= 150 ? 18 : 13,
              }}
            >
              World Patrons
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   ARC CARD SLIDER COMPONENT
   ============================================================ */
type ArcCard = { title: string; desc: string; color: string };

function ArcCardSlider({
  cards,
  rotationOffset,
  isMobile,
}: {
  cards: ArcCard[];
  rotationOffset: number;
  isMobile: boolean;
}) {
  const cardSpacingDeg = isMobile ? 12 : 9;
  const centerIndex = Math.floor(cards.length / 2);
  const arcRadius = isMobile ? 700 : 1100;
  const cardW = isMobile ? 160 : 220;
  const cardH = isMobile ? 175 : 230;
  const sliderH = isMobile ? 260 : 360;
  const borderRadius = isMobile ? 18 : 26;
  const titleSize = isMobile ? 22 : 30;
  const descSize = isMobile ? 12 : 15;
  const titleTop = isMobile ? 140 : 200;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
        }}
      >
        {cards.map((card, i) => {
          const baseDeg = (i - centerIndex) * cardSpacingDeg;
          const deg = baseDeg - rotationOffset + centerIndex * cardSpacingDeg;
          const rad = (deg * Math.PI) / 180;
          const x = Math.sin(rad) * arcRadius;
          const y = arcRadius - Math.cos(rad) * arcRadius;
          const halfW = cardW / 2;
          return (
            <div
              key={card.title}
              style={{
                position: 'absolute',
                bottom: -y + titleTop,
                left: `calc(50% + ${x}px - ${halfW}px)`,
                width: cardW,
                height: cardH,
                transform: `rotate(${deg}deg)`,
                transformOrigin: `${halfW}px ${arcRadius}px`,
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  background: card.color,
                  borderRadius,
                  boxShadow: '0 8px 40px rgba(80,40,60,0.18)',
                  position: 'relative',
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  overflow: 'hidden',
                }}
              >
                {/* numbered circle top-right */}
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: '1.5px solid rgba(80,50,60,0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: "'Imprima', sans-serif",
                    fontSize: 10,
                    color: 'rgba(80,50,60,0.6)',
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div
                  style={{
                    fontFamily: "'Viaoda Libre', serif",
                    fontSize: titleSize,
                    color: '#3a2530',
                    lineHeight: 1.1,
                  }}
                >
                  {card.title}
                </div>
                <div
                  style={{
                    fontFamily: "'Imprima', sans-serif",
                    fontSize: descSize,
                    color: 'rgba(58,37,48,0.65)',
                    marginTop: 6,
                    lineHeight: 1.4,
                  }}
                >
                  {card.desc}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* silhouette/floor hint (kept transparent for now) */}
      <div style={{ width: 0, height: sliderH }} />
    </div>
  );
}

/* ============================================================
   LOGIN PANEL — 用户名密码登录 / 邀请码注册账户
   ============================================================ */
type LoginMode = 'password' | 'register';

type CaptchaState = { challenge_id: string; image: string } | null;
type DeviceLimitState = {
  existing_devices: Array<{ browser: string; os: string; ip: string; last_active_time: string }>;
} | null;

type BanNoticeState = {
  title: string;
  lines: string[];
  revokedReason?: string | null;
  revokedAt?: string | null;
} | null;
type HoneypotState = {
  website: string;
  contact_method: string;
};

function LoginPanel({
  visible,
  isMobile,
  embedded = false,
}: {
  visible: boolean;
  isMobile: boolean;
  embedded?: boolean;
}) {
  // Active tab. Hash routing lets the panel survive a refresh:
  //   /login#password, /login#register, /login
  const initialMode: LoginMode = (() => {
    if (typeof window === 'undefined') return 'password';
    const h = window.location.hash.replace('#', '').toLowerCase();
    if (h === 'password' || h === 'register') return h;
    return 'password';
  })();
  const [mode, setMode] = useState<LoginMode>(initialMode);

  // Shared transient UI state.
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<CaptchaState>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [deviceLimit, setDeviceLimit] = useState<DeviceLimitState>(null);
  const [banNotice, setBanNotice] = useState<BanNoticeState>(null);

  // Per-mode form state.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginHoneypot, setLoginHoneypot] = useState<HoneypotState>({ website: '', contact_method: '' });
  const [regCode, setRegCode] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [registerHoneypot, setRegisterHoneypot] = useState<HoneypotState>({ website: '', contact_method: '' });
  const [showPwd, setShowPwd] = useState(false); // for password fields
  const [showRegPwd, setShowRegPwd] = useState(false);

  const clientFpRef = useRef<string>('');
  const captchaInputRef = useRef<HTMLInputElement | null>(null);

  // Compute a stable per-browser fingerprint. Same algorithm as the security
  // team uses (8 hex digits) so server-rendered captcha/key-token checks can
  // correlate against it.
  useEffect(() => {
    try {
      const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
      const parts = [
        navigator.userAgent, navigator.language || '',
        (navigator.languages || []).join(','),
        String(navigator.hardwareConcurrency || ''),
        String(dm || ''),
        String(screen.width + 'x' + screen.height + 'x' + screen.colorDepth),
        String(new Date().getTimezoneOffset()),
      ];
      let h = 0x811c9dc5;
      const s = parts.join('|');
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      clientFpRef.current = ('00000000' + h.toString(16)).slice(-8);
    } catch { clientFpRef.current = ''; }

    // Surface intent from the URL query (set by server redirects).
    const p = new URLSearchParams(location.search);
    if (p.get('revoked') === '1') setError('该邀请码已被吊销，请联系卖家。');
    else if (p.get('risk') === '1') setError('出于安全原因，请重新登录。');
    else if (p.get('next')) setInfo('请先登录以访问该页面。');
  }, []);

  // Reset captcha + transient error state when the user switches tabs.
  useEffect(() => {
    setCaptcha(null);
    setCaptchaAnswer('');
    setDeviceLimit(null);
    setError(null);
    setInfo(null);
    setBanNotice(null);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', mode === 'password' ? location.pathname + location.search : location.pathname + location.search + '#' + mode);
    }
  }, [mode]);

  // ----- Common error/result translator -----
  function applyResponseError(
    data: {
      ok?: boolean; error?: string; message?: string; reasons?: string[];
      title?: string; message_lines?: string[]; revoked_reason?: string | null; revoked_at?: string | null;
      captcha?: { challenge_id: string; image: string } | null;
      existing_devices?: Array<{ browser: string; os: string; ip: string; last_active_time: string }>;
    } | null,
    fallback: string,
  ) {
    if (!data) { setError(fallback); return; }
    if (data.error === 'captcha_required') {
      setCaptcha(data.captcha || null);
      setCaptchaAnswer('');
      setError('检测到异常登录，请输入图中数学答案继续');
      return;
    }
    if (data.error === 'captcha_wrong') {
      setError('答案错误，请重新输入');
      setCaptchaAnswer('');
      fetch('/api/captcha/new').then(r => r.json()).then(d => { if (d.ok) setCaptcha(d); }).catch(() => {});
      return;
    }
    if (data.error === 'device_limit') {
      setDeviceLimit({ existing_devices: data.existing_devices || [] });
      setError(data.message || '设备已达上限');
      return;
    }
    if (data.error === 'account_banned') {
      setError(null);
      setInfo(null);
      setBanNotice({
        title: data.title || '你的账号已被封禁',
        lines: Array.isArray(data.message_lines) && data.message_lines.length
          ? data.message_lines
          : String(data.message || '').split(/\n{2,}/).filter(Boolean),
        revokedReason: data.revoked_reason || null,
        revokedAt: data.revoked_at || null,
      });
      return;
    }
    if (data.error === 'risk_blocked') {
      setError(data.message || '登录被风控拦截，请联系客服。');
      return;
    }
    if (data.error === 'code_login_disabled' || data.error === 'code_login_removed') {
      setMode('password');
      setError(data.message || '请使用用户名密码登录');
      return;
    }
    setError(data.message || data.error || fallback);
  }

  async function refreshCaptcha() {
    try {
      const r = await fetch('/api/captcha/new');
      const d = await r.json();
      if (d.ok) {
        setCaptcha(d);
        setCaptchaAnswer('');
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (!captcha) return;
    const tid = window.setTimeout(() => captchaInputRef.current?.focus(), 80);
    return () => window.clearTimeout(tid);
  }, [captcha?.challenge_id]);

  function focusCaptchaInput() {
    window.setTimeout(() => captchaInputRef.current?.focus(), 0);
  }

  // ----- Login (mode='password') -----
  async function onLoginPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'password',
          username: username.trim(),
          password,
          website: loginHoneypot.website,
          contact_method: loginHoneypot.contact_method,
          next: new URLSearchParams(location.search).get('next') || '/',
          client_fp: clientFpRef.current,
          ...(captcha ? { captcha_id: captcha.challenge_id, captcha_answer: captchaAnswer.trim() } : {}),
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        setInfo(`欢迎回来, ${data.username || username.trim()} · 跳转中…`);
        setTimeout(() => { location.href = data.next || '/'; }, 250);
        return;
      }
      applyResponseError(data, '用户名或密码错误');
      setSubmitting(false);
    } catch (err) {
      setError('网络错误：' + (err as Error).message);
      setSubmitting(false);
    }
  }

  // ----- Register -----
  async function onRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!regUsername.trim() || !regPassword || submitting) return;
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const r = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: regCode.trim() || undefined,
          username: regUsername.trim(),
          password: regPassword,
          website: registerHoneypot.website,
          contact_method: registerHoneypot.contact_method,
          client_fp: clientFpRef.current,
          ...(captcha ? { captcha_id: captcha.challenge_id, captcha_answer: captchaAnswer.trim() } : {}),
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        setInfo(`注册成功, ${data.username || ''} · 跳转中…`);
        setTimeout(() => { location.href = data.next || '/'; }, 350);
        return;
      }
      applyResponseError(data, '注册失败');
      setSubmitting(false);
    } catch (err) {
      setError('网络错误：' + (err as Error).message);
      setSubmitting(false);
    }
  }

  // ----- Shared sub-blocks -----
  function CaptchaBlock() {
    if (!captcha) return null;
    return (
      <div
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) focusCaptchaInput();
        }}
        style={{
          position: 'relative',
          zIndex: 3,
          marginBottom: 16,
          padding: 12,
          background: 'rgba(99,102,241,.08)',
          border: '1px solid rgba(99,102,241,.35)',
          borderRadius: 12,
          pointerEvents: 'auto',
          isolation: 'isolate',
        }}
      >
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', marginBottom: 8, letterSpacing: '.06em', textTransform: 'uppercase' }}>安全验证</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={captcha.image} alt="captcha" style={{ display: 'block', borderRadius: 8, background: '#fafafa', width: 160, height: 60 }} />
          <button
            type="button"
            onClick={refreshCaptcha}
            style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, color: 'rgba(255,255,255,0.85)', fontSize: 12, cursor: 'pointer' }}
          >
            换一题
          </button>
        </div>
        <input
          ref={captchaInputRef}
          type="tel"
          name="captcha_answer"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          placeholder="请输入图中的数学答案"
          value={captchaAnswer}
          onPointerDown={focusCaptchaInput}
          onMouseDown={focusCaptchaInput}
          onTouchStart={focusCaptchaInput}
          onInput={(e) => setCaptchaAnswer(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
          onChange={(e) => setCaptchaAnswer(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onFocus={inputHandlers(true)}
          onBlur={inputHandlers(false)}
          style={{
            marginTop: 8, width: '100%', padding: '10px 12px',
            background: 'rgba(10,10,15,0.7)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10, color: '#fff', fontSize: 14, outline: 'none',
            boxSizing: 'border-box', WebkitTextFillColor: '#fff',
            opacity: 1, pointerEvents: 'auto',
          }}
        />
      </div>
    );
  }

  function DeviceLimitBlock() {
    if (!deviceLimit) return null;
    return (
      <div style={{ marginBottom: 16, padding: 12, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.35)', borderRadius: 12, color: '#fecaca', fontSize: 12, lineHeight: 1.6 }}>
        <b style={{ display: 'block', marginBottom: 6 }}>设备已达上限</b>
        当前已登录设备：
        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
          {deviceLimit.existing_devices.map((d, i) => (
            <li key={i}>{d.os || '?'} · {d.browser || '?'} · {d.ip || '?'}</li>
          ))}
        </ul>
        请先在已登录设备访问「个人中心 → 登录设备」踢出陌生设备后再试。
      </div>
    );
  }

  function MessageBlock() {
    if (banNotice) {
      return (
        <div
          style={{
            marginTop: 14,
            padding: 16,
            borderRadius: 16,
            background: 'linear-gradient(180deg, rgba(60,22,28,0.92), rgba(22,18,23,0.92))',
            color: '#f4f4f5',
            border: '1px solid rgba(248,113,113,0.34)',
            boxShadow: '0 20px 54px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.04) inset',
          }}
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div
              aria-hidden="true"
              style={{
                width: 34,
                height: 34,
                borderRadius: 12,
                flex: '0 0 auto',
                display: 'grid',
                placeItems: 'center',
                color: '#fecaca',
                fontWeight: 900,
                background: 'rgba(248,113,113,0.14)',
                border: '1px solid rgba(248,113,113,0.35)',
              }}
            >
              !
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', marginBottom: 8 }}>
                {banNotice.title}
              </div>
              <div style={{ display: 'grid', gap: 9 }}>
                {banNotice.lines.map((line, i) => (
                  <p key={i} style={{ margin: 0, fontSize: 13, lineHeight: 1.72, color: '#e5e7eb' }}>
                    {line}
                  </p>
                ))}
              </div>
              {(banNotice.revokedReason || banNotice.revokedAt) && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '9px 10px',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: '#a1a1aa',
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  {banNotice.revokedReason && <div>封禁原因：{banNotice.revokedReason}</div>}
                  {banNotice.revokedAt && <div>封禁时间：{new Date(banNotice.revokedAt).toLocaleString()}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
    if (!error && !info) return null;
    return (
      <div
        style={{
          marginTop: 12,
          padding: '10px 12px',
          borderRadius: 10,
          fontSize: 12.5,
          background: error ? 'rgba(248,113,113,0.14)' : 'rgba(99,102,241,0.14)',
          color: error ? '#fca5a5' : '#c7d2fe',
          border: error
            ? '1px solid rgba(248,113,113,0.32)'
            : '1px solid rgba(99,102,241,0.32)',
        }}
      >
        {error || info}
      </div>
    );
  }

  // Style helpers
  const labelStyle: CSSProperties = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.48)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    marginBottom: 7,
  };
  const baseInputStyle: CSSProperties = {
    width: '100%',
    padding: '14px 16px',
    background: 'rgba(255,255,255,0.055)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 0,
    color: '#fff',
    fontFamily: "'Imprima', 'PingFang SC', ui-sans-serif, system-ui, sans-serif",
    fontSize: 13,
    lineHeight: 1.5,
    letterSpacing: '0.02em',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color .15s, box-shadow .15s',
  };
  function inputHandlers(focus: boolean): React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement> {
    return (e) => {
      if (focus) {
        e.currentTarget.style.borderColor = '#CB8DFF';
        e.currentTarget.style.background = 'rgba(255,255,255,0.09)';
        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(203,141,255,0.18)';
      } else {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
        e.currentTarget.style.background = 'rgba(255,255,255,0.055)';
        e.currentTarget.style.boxShadow = 'none';
      }
    };
  }

  const honeypotWrapStyle: CSSProperties = {
    position: 'absolute',
    left: '-10000px',
    top: 'auto',
    width: 1,
    height: 1,
    overflow: 'hidden',
    opacity: 0,
  };

  function HoneypotFields({
    scope,
    value,
    onChange,
  }: {
    scope: string;
    value: HoneypotState;
    onChange: (next: HoneypotState) => void;
  }) {
    return (
      <div aria-hidden="true" style={honeypotWrapStyle}>
        <label htmlFor={`${scope}-website`}>官网</label>
        <input
          id={`${scope}-website`}
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={value.website}
          onChange={(e) => onChange({ ...value, website: e.target.value })}
        />
        <label htmlFor={`${scope}-contact-method`}>联系渠道</label>
        <input
          id={`${scope}-contact-method`}
          name="contact_method"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={value.contact_method}
          onChange={(e) => onChange({ ...value, contact_method: e.target.value })}
        />
      </div>
    );
  }

  // Tab definitions. Each tab gets a stable key so React can reconcile.
  const TABS: Array<{ key: LoginMode; label: string; sub: string }> = [
    { key: 'password', label: '用户名密码', sub: '已注册的账号' },
    { key: 'register', label: '注册账户', sub: '邀请码可选' },
  ];

  const cardW = isMobile ? 'min(94vw, 460px)' : 450;
  const cardMaxHeight = isMobile ? 'calc(100svh - 28px)' : 'calc(100svh - 48px)';

  return (
    <div
      style={{
        position: embedded ? 'relative' : 'absolute',
        inset: embedded ? 'auto' : 0,
        zIndex: visible ? 80 : 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: embedded ? 0 : isMobile ? '14px 0' : '24px 0',
        pointerEvents: visible ? 'auto' : 'none',
        opacity: visible ? 1 : 0,
        transform: embedded ? 'none' : visible ? 'translateY(0)' : 'translateY(40px)',
        transition: 'opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <div
        className="login-panel-scroll"
        style={{
          width: embedded ? '100%' : cardW,
          maxWidth: cardW,
          maxHeight: embedded ? (isMobile ? 'none' : 'calc(100svh - 150px)') : cardMaxHeight,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          position: 'relative',
          zIndex: 1,
          padding: isMobile ? '24px 20px' : '40px 38px',
          borderRadius: 0,
          background: 'rgba(0, 0, 0, 0.50)',
          backdropFilter: 'blur(46px) saturate(125%)',
          WebkitBackdropFilter: 'blur(46px) saturate(125%)',
          border: '1px solid rgba(255,255,255,0.11)',
          boxShadow: '0 34px 90px rgba(0,0,0,0.58), 0 0 0 1px rgba(255,255,255,0.035) inset',
          color: '#fff',
          fontFamily: "'Imprima', 'PingFang SC', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 18 }}>
          <BloomLogo size={40} />
          <span style={{ fontFamily: "'Viaoda Libre', serif", fontWeight: 500, fontSize: 22, letterSpacing: '-0.02em' }}>
            {BRAND}
          </span>
        </div>

        {/* Heading */}
        <div
          style={{
            fontFamily: "'Viaoda Libre', serif",
            fontSize: isMobile ? 28 : 32,
            lineHeight: 1.15,
            letterSpacing: '-0.02em',
            marginBottom: 8,
            textAlign: 'center',
          }}
        >
          进入 Prompt Vault
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.6,
            color: 'rgba(255,255,255,0.48)',
            marginBottom: 24,
            textAlign: 'center',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          登录后查看完整提示词正文与会员内容
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          style={{
            display: 'flex',
            gap: 6,
            padding: 4,
            borderRadius: 0,
            background: 'rgba(255,255,255,0.045)',
            border: '1px solid rgba(255,255,255,0.08)',
            marginBottom: 22,
          }}
        >
          {TABS.map((t) => {
            const active = t.key === mode;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(t.key)}
                style={{
                  flex: 1,
                  padding: isMobile ? '9px 4px' : '11px 12px',
                  fontSize: isMobile ? 12 : 13,
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  border: 'none',
                  borderRadius: 0,
                  cursor: 'pointer',
                  color: active ? '#fff' : 'rgba(255,255,255,0.50)',
                  background: active ? '#CB8DFF' : 'transparent',
                  boxShadow: active ? '0 12px 26px rgba(203,141,255,0.22)' : 'none',
                  transition: 'background .18s, color .18s, box-shadow .18s',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Per-mode body */}
        {mode === 'password' && (
          <form onSubmit={onLoginPassword}>
            <HoneypotFields scope="login" value={loginHoneypot} onChange={setLoginHoneypot} />
            <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.50)', lineHeight: 1.55, marginBottom: 16, textAlign: 'center' }}>
              {TABS[0].sub}
            </p>

            <label style={labelStyle}>用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="4-20 字符 (字母 / 数字 / 下划线 / 中文)"
              autoComplete="username"
              required
              style={baseInputStyle}
              onFocus={inputHandlers(true)}
              onBlur={inputHandlers(false)}
            />
            <div style={{ height: 12 }} />

            <label style={labelStyle}>密码</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPwd ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 8 个字符"
                autoComplete="current-password"
                required
                style={{ ...baseInputStyle, paddingRight: 64 }}
                onFocus={inputHandlers(true)}
                onBlur={inputHandlers(false)}
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                style={{
                  position: 'absolute', right: 8, top: '50%',
                  transform: 'translateY(-50%)',
                  padding: '6px 10px',
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 0, color: 'rgba(255,255,255,0.75)',
                  fontSize: 11, cursor: 'pointer',
                }}
              >
                {showPwd ? '隐藏' : '显示'}
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 6, marginBottom: 14 }}>
              忘密码请找客服重置。
            </div>

            <CaptchaBlock />
            <DeviceLimitBlock />

            <button
              type="submit"
              disabled={submitting || !username.trim() || !password}
              style={{
                width: '100%', padding: '15px 18px',
                background: submitting ? '#8b5cf6' : '#CB8DFF',
                color: '#fff', border: 'none', borderRadius: 0,
                fontWeight: 700, fontSize: 13,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                cursor: submitting ? 'wait' : 'pointer',
                opacity: submitting ? 0.85 : 1,
                boxShadow: '0 18px 44px rgba(203,141,255,0.28)',
              }}
            >
              {submitting ? '登录中…' : '登录'}
            </button>

            <MessageBlock />

            <div
              style={{
                marginTop: 16, paddingTop: 12,
                borderTop: '1px solid rgba(255,255,255,0.08)',
                fontSize: 11.5, color: 'rgba(255,255,255,0.5)',
                textAlign: 'center', lineHeight: 1.6,
              }}
            >
              第一次来？{' '}
              <a
                href="#register"
                onClick={(e) => { e.preventDefault(); setMode('register'); }}
                style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'underline', cursor: 'pointer' }}
              >
                去注册账户
              </a>
            </div>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={onRegister}>
            <HoneypotFields scope="register" value={registerHoneypot} onChange={setRegisterHoneypot} />
            <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.50)', lineHeight: 1.55, marginBottom: 16, textAlign: 'center' }}>
              {TABS[1].sub}
            </p>

            <label style={labelStyle}>邀请码</label>
            <textarea
              value={regCode}
              onChange={(e) => setRegCode(e.target.value)}
              placeholder="留空即可直接注册；有邀请码就粘贴进来"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              rows={2}
              style={baseInputStyle}
              onFocus={inputHandlers(true)}
              onBlur={inputHandlers(false)}
            />
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 6, marginBottom: 12 }}>
              普通注册不需要邀请码；邀请码会把账号升级为会员类型。
            </div>
            <label style={labelStyle}>用户名</label>
            <input
              type="text"
              value={regUsername}
              onChange={(e) => setRegUsername(e.target.value)}
              placeholder="4-20 字符, 区分大小写"
              autoComplete="username"
              required
              style={baseInputStyle}
              onFocus={inputHandlers(true)}
              onBlur={inputHandlers(false)}
            />
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 6, marginBottom: 12 }}>
              Alice 与 alice 是不同账号。
            </div>

            <label style={labelStyle}>密码</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showRegPwd ? 'text' : 'password'}
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                placeholder="至少 8 个字符"
                autoComplete="new-password"
                required
                style={{ ...baseInputStyle, paddingRight: 64 }}
                onFocus={inputHandlers(true)}
                onBlur={inputHandlers(false)}
              />
              <button
                type="button"
                onClick={() => setShowRegPwd((v) => !v)}
                style={{
                  position: 'absolute', right: 8, top: '50%',
                  transform: 'translateY(-50%)',
                  padding: '6px 10px',
                  background: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 0, color: 'rgba(255,255,255,0.75)',
                  fontSize: 11, cursor: 'pointer',
                }}
              >
                {showRegPwd ? '隐藏' : '显示'}
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 6, marginBottom: 14 }}>
              如果填写了邀请码，提交后它将不可再用；账号会永久保留登录权限。
            </div>

            <CaptchaBlock />
            <DeviceLimitBlock />

            <button
              type="submit"
              disabled={submitting || !regUsername.trim() || !regPassword}
              style={{
                width: '100%', padding: '15px 18px',
                background: submitting ? '#8b5cf6' : '#CB8DFF',
                color: '#fff', border: 'none', borderRadius: 0,
                fontWeight: 700, fontSize: 13,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                cursor: submitting ? 'wait' : 'pointer',
                opacity: submitting ? 0.85 : 1,
                boxShadow: '0 18px 44px rgba(203,141,255,0.28)',
              }}
            >
              {submitting ? '注册中…' : '注册并登录'}
            </button>

            <MessageBlock />

            <div
              style={{
                marginTop: 16, paddingTop: 12,
                borderTop: '1px solid rgba(255,255,255,0.08)',
                fontSize: 11.5, color: 'rgba(255,255,255,0.5)',
                textAlign: 'center', lineHeight: 1.6,
              }}
            >
              已经有账号？{' '}
              <a
                href="#password"
                onClick={(e) => { e.preventDefault(); setMode('password'); }}
                style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'underline', cursor: 'pointer' }}
              >
                用户名密码登录
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function TutorialModal({
  open,
  onClose,
  isMobile,
}: {
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const openTutorial = () => {
    window.open(TUTORIAL_URL, '_blank', 'noopener,noreferrer');
  };

  const copyTutorialLink = async () => {
    try {
      await navigator.clipboard.writeText(TUTORIAL_URL);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="使用教程"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: isMobile ? 18 : 28,
        background: 'rgba(7, 4, 10, 0.82)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(1100px, 100%)',
          borderRadius: isMobile ? 20 : 24,
          overflow: 'hidden',
          background: 'rgba(18, 16, 24, 0.94)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.55)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: isMobile ? 'flex-start' : 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: isMobile ? '16px 16px 12px' : '18px 20px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "'Viaoda Libre', serif",
                fontSize: isMobile ? 24 : 28,
                color: '#fff',
                lineHeight: 1.1,
              }}
            >
              使用教程
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 12.5,
                lineHeight: 1.6,
                color: 'rgba(255,255,255,0.62)',
              }}
            >
              教程托管在抖音，点一下就能直接播放，站内不再加载大视频。
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              flexShrink: 0,
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.05)',
              color: '#fff',
              fontSize: 22,
              lineHeight: 1,
              cursor: 'pointer',
            }}
            aria-label="关闭教程"
          >
            ×
          </button>
        </div>

        <div style={{ padding: isMobile ? 12 : 16 }}>
          <div
            style={{
              width: '100%',
              aspectRatio: '16 / 9',
              minHeight: isMobile ? 240 : 420,
              maxHeight: isMobile ? '58vh' : '72vh',
              borderRadius: 18,
              overflow: 'hidden',
              background:
                'radial-gradient(circle at top, rgba(99,102,241,0.34), transparent 40%), linear-gradient(160deg, rgba(18,16,24,0.98), rgba(9,8,14,0.98))',
              boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              textAlign: 'center',
              padding: isMobile ? '26px 20px' : '36px 42px',
            }}
          >
            <div
              style={{
                width: isMobile ? 70 : 88,
                height: isMobile ? 70 : 88,
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'linear-gradient(135deg, rgba(99,102,241,0.94), rgba(244,114,182,0.9))',
                boxShadow: '0 20px 48px rgba(99,102,241,0.28)',
                color: '#fff',
              }}
            >
              <svg width={isMobile ? 30 : 38} height={isMobile ? 30 : 38} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
            <div
              style={{
                marginTop: isMobile ? 18 : 22,
                fontFamily: "'Viaoda Libre', serif",
                fontSize: isMobile ? 28 : 36,
                lineHeight: 1.08,
                color: '#fff',
              }}
            >
              抖音教程直达
            </div>
            <div
              style={{
                marginTop: 12,
                maxWidth: 520,
                fontSize: isMobile ? 13 : 15,
                lineHeight: 1.8,
                color: 'rgba(255,255,255,0.72)',
              }}
            >
              抖音限制了第三方站点内嵌播放，所以这里改成轻量入口。
              点开后会直接跳到你发布的教程视频，不占本站服务器带宽。
            </div>
            <div
              style={{
                marginTop: isMobile ? 20 : 24,
                display: 'flex',
                flexDirection: isMobile ? 'column' : 'row',
                gap: 12,
                width: isMobile ? '100%' : 'auto',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                onClick={openTutorial}
                style={{
                  minWidth: isMobile ? '100%' : 220,
                  border: 0,
                  borderRadius: 999,
                  padding: isMobile ? '14px 18px' : '14px 24px',
                  background: 'linear-gradient(135deg, #6366f1, #f472b6)',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 16px 36px rgba(99,102,241,0.26)',
                }}
              >
                打开抖音教程
              </button>
              <button
                type="button"
                onClick={copyTutorialLink}
                style={{
                  minWidth: isMobile ? '100%' : 170,
                  borderRadius: 999,
                  padding: isMobile ? '13px 18px' : '13px 20px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  color: copied ? '#f9a8d4' : '#fff',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {copied ? '链接已复制' : '复制教程链接'}
              </button>
            </div>
            <div
              style={{
                marginTop: 14,
                fontSize: 12,
                color: 'rgba(255,255,255,0.44)',
                wordBreak: 'break-all',
              }}
            >
              {TUTORIAL_URL}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
function LegacyApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const cloudsRef = useRef<HTMLDivElement | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const curtainLRef = useRef<HTMLDivElement | null>(null);
  const curtainRRef = useRef<HTMLDivElement | null>(null);

  const [scrollProgress, setScrollProgress] = useState(0);
  const [curtainsOpen, setCurtainsOpen] = useState(false);
  const [uiVisible, setUiVisible] = useState(false);
  const [entranceDone, setEntranceDone] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [mouseTarget, setMouseTarget] = useState({ x: 0, y: 0 });
  const mouseSmooth = useRef({ x: 0, y: 0 });
  const rafId = useRef<number | null>(null);

  const isMobile = useIsMobile();

  /* Smoothly scroll the page to where the login form appears (~58% of total).
     Triggered by the nav "登录 / 解锁 →" buttons. */
  const jumpToLogin = useRef<() => void>(() => {});
  jumpToLogin.current = () => {
    const el = containerRef.current;
    if (!el) return;
    const total = el.scrollHeight - window.innerHeight;
    if (total <= 0) return;
    const target = total * 0.84;
    const start = window.scrollY;
    const delta = target - start;
    const duration = 1100; // ms — matches the cinematic pacing
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      // ease-in-out cubic for a calm arrival
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      window.scrollTo(0, start + delta * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  /* entrance sequence */
  useEffect(() => {
    const t1 = window.setTimeout(() => setCurtainsOpen(true), 100);
    const t2 = window.setTimeout(() => setUiVisible(true), 600);
    const t3 = window.setTimeout(() => setEntranceDone(true), 2200);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, []);

  /* already-authed users skip the cinematic and go straight to the app */
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && data.ok) {
          location.replace('/');
        }
      })
      .catch(() => { /* stay on login */ });
    return () => { cancelled = true; };
  }, []);

  /* scroll progress */
  useEffect(() => {
    // Demo mode: ?scroll=half jumps straight to the login panel
    const params = new URLSearchParams(location.search);
    if (params.get('scroll') === 'half') {
      setScrollProgress(0.6);
    }
    const onScroll = () => {
      const el = containerRef.current;
      if (!el) return;
      const total = el.scrollHeight - window.innerHeight;
      const p = total > 0 ? window.scrollY / total : 0;
      setScrollProgress(clamp(p, 0, 1));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  /* mouse parallax */
  useEffect(() => {
    if (isMobile) return;
    const onMove = (e: MouseEvent) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = (e.clientY / window.innerHeight) * 2 - 1;
      setMouseTarget({ x: nx, y: ny });
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [isMobile]);

  /* smoothed mouse loop */
  useEffect(() => {
    const tick = () => {
      mouseSmooth.current.x = lerp(mouseSmooth.current.x, mouseTarget.x, 0.07);
      mouseSmooth.current.y = lerp(mouseSmooth.current.y, mouseTarget.y, 0.07);
      rafId.current = requestAnimationFrame(tick);
    };
    rafId.current = requestAnimationFrame(tick);
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, [mouseTarget]);

  /* derived values */
  const ep = easeInOut(scrollProgress);
  const scene1Opacity = clamp(1 - scrollProgress / 0.20, 0, 1);
  const featureSceneOpacity = clamp((scrollProgress - 0.18) / 0.12, 0, 1) *
                              (1 - clamp((scrollProgress - 0.45) / 0.10, 0, 1));
  // Scene 2 (营销文案) 在中后段淡入淡出，节奏参考 Bloom 的 mission scene
  const scene2Opacity = clamp((scrollProgress - 0.45) / 0.12, 0, 1) *
                        (1 - clamp((scrollProgress - 0.68) / 0.10, 0, 1));
  // Login 面板作为最后一幕出现
  const loginVisible = scrollProgress >= 0.76;
  // 顶部滚动提示：仅在用户尚未滚动时显示，开始滚动后淡出
  const scrollHintVisible = scrollProgress < 0.05;
  const arcSweepDeg = (ARC_CARDS.length - 1) * 10;
  const arcRotation = lerp(0, arcSweepDeg, clamp((scrollProgress - 0.7) / 0.3, 0, 1));

  const cloudsOpacity = clamp(lerp(0.7, 1, scrollProgress / 0.05), 0.7, 1);
  const portalOpacity = scrollProgress < 0.38 ? 1 : scrollProgress >= 0.66 ? 0.1 : 1 - (scrollProgress - 0.38) / 0.28;

  const mx = mouseSmooth.current;
  const worldOffsetX = -mx.x * MAG.world;
  const worldOffsetY = -mx.y * MAG.world;
  const cloudsOffsetX = -mx.x * MAG.clouds;
  const cloudsOffsetY = -mx.y * MAG.clouds * 0.4;
  const portalOffsetX = -mx.x * MAG.portal;
  const portalOffsetY = -mx.y * MAG.portal;
  const curtainLOffsetX = -mx.x * MAG.curtainL;
  const curtainLOffsetY = -mx.y * MAG.curtainL * 0.3;
  const curtainROffsetX = -mx.x * MAG.curtainR;
  const curtainROffsetY = -mx.y * MAG.curtainR * 0.3;

  /* card slider bottom */
  const cardSliderBottom = isMobile ? 60 : 80;

  /* ------------------- entrance animation keyframes injected once ------------------- */
  const styleEl = useMemo(() => {
    if (typeof document === 'undefined') return null;
    let el = document.getElementById('portal-keyframes') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'portal-keyframes';
      document.head.appendChild(el);
    }
    el.textContent = `
      @keyframes scene1FadeIn {
        from { opacity: 0; transform: translateY(16px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes scene1CardIn {
        from { opacity: 0; transform: translateY(20px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes scene2FadeIn {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes hintBob {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(4px); }
      }
      @keyframes tutorialBadgeFloat {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-7px); }
      }
      @keyframes tutorialBadgeGlow {
        0%, 100% {
          box-shadow:
            0 18px 42px -14px rgba(244,114,182,0.72),
            0 0 20px rgba(99,102,241,0.24),
            0 0 0 1px rgba(255,255,255,0.1) inset;
        }
        50% {
          box-shadow:
            0 26px 52px -14px rgba(244,114,182,0.94),
            0 0 34px rgba(244,114,182,0.34),
            0 0 42px rgba(99,102,241,0.28),
            0 0 0 1px rgba(255,255,255,0.16) inset;
        }
      }
      @keyframes tutorialBadgeCoreGlow {
        0%, 100% {
          box-shadow:
            0 0 14px rgba(255,255,255,0.16),
            0 0 0 1px rgba(255,255,255,0.08) inset;
        }
        50% {
          box-shadow:
            0 0 22px rgba(255,255,255,0.26),
            0 0 28px rgba(244,114,182,0.18),
            0 0 0 1px rgba(255,255,255,0.14) inset;
        }
      }
    `;
    return el;
  }, []);

  /* ============================================================
     RENDER
     ============================================================ */
  return (
    <>
      <div
        ref={containerRef}
        style={{ height: '500vh', position: 'relative', background: '#000' }}
      >
        <div
          style={{
            position: 'sticky',
            top: 0,
            height: '100vh',
            overflow: 'hidden',
            background: '#000',
          }}
        >
          <BloomCanvasBackdrop scrollProgress={scrollProgress} />
          <AmbientBackdrop scrollProgress={scrollProgress} />

          {/* === Layer 1: World Background === */}
          <div
            ref={worldRef}
            style={{
              position: 'absolute',
              inset: 0,
              transformOrigin: '50% 50%',
              transform: `translate(${worldOffsetX}px, ${worldOffsetY}px) scale(${lerp(1, 1.18, ep)})`,
              willChange: 'transform',
            }}
          >
            <img
              src={WORLD_BG}
              alt=""
              onError={hideBrokenDecorImage}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>

          {/* === Layer 2.5: Arc Card Slider (under portal) === */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: cardSliderBottom,
              zIndex: 9,
              opacity: 0,
              pointerEvents: 'none',
              height: 0,
              display: 'none',
            }}
          >
            <ArcCardSlider
              cards={ARC_CARDS}
              rotationOffset={arcRotation}
              isMobile={isMobile}
            />
          </div>

          {/* === Layer 2: Bottom Clouds === */}
          <div
            ref={cloudsRef}
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              zIndex: 10,
              transformOrigin: '50% 100%',
              opacity: cloudsOpacity,
              transform: `translate(${cloudsOffsetX}px, ${cloudsOffsetY}px) scale(${lerp(1, 1.4, ep)})`,
              willChange: 'transform, opacity',
            }}
          >
            {BOTTOM_CLOUDS ? (
              <img
                src={BOTTOM_CLOUDS}
                alt=""
                onError={hideBrokenDecorImage}
                style={{ width: '100%', height: 'auto', display: 'block' }}
              />
            ) : null}
          </div>

          {/* === Layer 3: Portal Frame === */}
          <div
            ref={portalRef}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 15,
              transformOrigin: '52% 38%',
              opacity: portalOpacity,
              transform: `translate(${portalOffsetX}px, ${portalOffsetY}px) scale(${lerp(1, 7.5, ep)})`,
              willChange: 'transform, opacity',
            }}
          >
            <img
              src={PORTAL_BG}
              alt=""
              onError={hideBrokenDecorImage}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>

          {/* === Layer 3.5: Bottom Fade === */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: '40%',
              zIndex: 16,
              background: 'linear-gradient(to top, rgba(0,0,0,0.45) 0%, transparent 100%)',
              pointerEvents: 'none',
            }}
          />

          {/* === Layer 4L: Curtain Left === */}
          <div
            ref={curtainLRef}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 16,
              transformOrigin: 'left center',
              overflow: 'hidden',
              transform: `translate(${curtainLOffsetX}px, ${curtainLOffsetY}px) translateX(${curtainsOpen ? '-150%' : '0%'}) translateX(${lerp(0, -100, ep)}%) scale(${lerp(1, 1.3, ep)})`,
              transition: entranceDone ? 'none' : 'transform 1.8s cubic-bezier(0.16, 1, 0.3, 1)',
              willChange: 'transform',
            }}
          >
            {CURTAIN_LEFT ? (
              <img
                src={CURTAIN_LEFT}
                alt=""
                onError={hideBrokenDecorImage}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'right center',
                }}
              />
            ) : null}
          </div>

          {/* === Layer 4R: Curtain Right === */}
          <div
            ref={curtainRRef}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 16,
              transformOrigin: 'right center',
              overflow: 'hidden',
              transform: `translate(${curtainROffsetX}px, ${curtainROffsetY}px) translateX(${curtainsOpen ? '150%' : '0%'}) translateX(${lerp(0, 100, ep)}%) scale(${lerp(1, 1.3, ep)})`,
              transition: entranceDone ? 'none' : 'transform 1.8s cubic-bezier(0.16, 1, 0.3, 1)',
              willChange: 'transform',
            }}
          >
            {CURTAIN_RIGHT ? (
              <img
                src={CURTAIN_RIGHT}
                alt=""
                onError={hideBrokenDecorImage}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'left center',
                }}
              />
            ) : null}
          </div>

          {/* === Top Fade Gradient === */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: '42vh',
              zIndex: 45,
              background: 'linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, transparent 100%)',
              pointerEvents: 'none',
            }}
          />

          {/* === Navigation === */}
          <Nav
            isMobile={isMobile}
            onJumpToLogin={() => jumpToLogin.current()}
            onOpenTutorial={() => setTutorialOpen(true)}
          />

          {/* === Scroll Hint (顶部提示：向下滚动进入登录) === */}
          <div
            style={{
              position: 'absolute',
              top: isMobile ? 60 : 80,
              left: 0,
              right: 0,
              zIndex: 49,
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
              opacity: scrollHintVisible && uiVisible ? 1 : 0,
              transform: scrollHintVisible && uiVisible ? 'translateY(0)' : 'translateY(-6px)',
              transition: 'opacity 0.6s ease, transform 0.6s ease',
            }}
          >
            <div
              onClick={() => jumpToLogin.current()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') jumpToLogin.current(); }}
              style={{
                pointerEvents: scrollHintVisible ? 'auto' : 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                padding: isMobile ? '8px 14px' : '10px 18px',
                borderRadius: 999,
                background: 'rgba(20, 18, 24, 0.55)',
                border: '1px solid rgba(255,255,255,0.18)',
                backdropFilter: 'blur(10px)',
                WebkitBackdropFilter: 'blur(10px)',
                color: 'rgba(255,255,255,0.92)',
                fontFamily: "'Imprima', 'PingFang SC', sans-serif",
                fontSize: isMobile ? 12 : 13,
                letterSpacing: '0.02em',
                cursor: 'pointer',
                userSelect: 'none',
                boxShadow: '0 8px 24px -10px rgba(0,0,0,0.6)',
                animation: scrollHintVisible && uiVisible ? 'hintBob 2.2s ease-in-out infinite' : 'none',
              }}
            >
              <span>向下滚动鼠标进入登录页面</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </div>
          </div>

          {/* === SCENE 1 UI === */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 20,
              opacity: scene1Opacity,
              pointerEvents: scene1Opacity > 0.2 ? 'auto' : 'none',
            }}
          >
            {/* --- Mobile layout --- */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: isMobile ? 'flex' : 'none',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '80px 24px 100px',
                gap: 22,
              }}
            >
              <div
                style={{
                  opacity: uiVisible ? 1 : 0,
                  transform: uiVisible ? 'translateY(0)' : 'translateY(16px)',
                  transition: 'opacity 0.9s ease, transform 0.9s ease',
                  transitionDelay: '0.3s',
                }}
              >
                <Scene1HeadingMobile />
              </div>

              <div
                style={{
                  opacity: uiVisible ? 1 : 0,
                  transform: uiVisible ? 'translateY(0)' : 'translateY(16px)',
                  transition: 'opacity 0.9s ease, transform 0.9s ease',
                  transitionDelay: '0.3s',
                }}
              >
                <Scene1SubtextMobile />
              </div>

              <div
                style={{
                  marginTop: 4,
                  opacity: uiVisible ? 1 : 0,
                  transform: uiVisible ? 'translateY(0)' : 'translateY(20px)',
                  animation: uiVisible ? undefined : 'none',
                }}
              >
                <ShowcaseCard
                  size={140}
                  radius={22}
                  image={CARD_IMAGES[0]}
                  kind="play"
                  delay={0.55}
                />
              </div>
            </div>

            {/* --- Tablet layout --- */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'none',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '80px 32px 96px',
                gap: 28,
              }}
            >
              <div
                style={{
                  textAlign: 'center',
                  opacity: uiVisible ? 1 : 0,
                  transform: uiVisible ? 'translateY(0)' : 'translateY(16px)',
                  transition: 'opacity 0.9s ease, transform 0.9s ease',
                  transitionDelay: '0.3s',
                }}
              >
                <div
                  style={{
                    fontFamily: "'Viaoda Libre', serif",
                    fontSize: 'clamp(26px, 4.5vw, 38px)',
                    letterSpacing: '0.16em',
                color: '#fff',
                textShadow: '0 2px 22px rgba(0,0,0,0.46)',
                  }}
                >
                  解锁 PROMPT <span style={{ color: '#6b2e0e', fontSize: '0.8em' }}>›</span> 灵感库
                </div>
                <div
                  style={{
                    fontFamily: "'Viaoda Libre', serif",
                    fontStyle: 'italic',
                    fontSize: 'clamp(54px, 11vw, 80px)',
                    letterSpacing: '-0.02em',
                    lineHeight: 1,
                    color: '#fff',
                    textShadow: '0 2px 22px rgba(0,0,0,0.46)',
                    marginTop: 4,
                  }}
                >
                  VAULT
                </div>
              </div>

              <p
                style={{
                  fontFamily: "'Imprima', 'PingFang SC', sans-serif",
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: 'rgba(255,255,255,0.78)',
                  maxWidth: 400,
                  textAlign: 'center',
                  opacity: uiVisible ? 1 : 0,
                  transform: uiVisible ? 'translateY(0)' : 'translateY(16px)',
                  transition: 'opacity 0.9s ease, transform 0.9s ease',
                  transitionDelay: '0.3s',
                }}
              >
                253 套 React + Tailwind 动效提示词 · 不定期更新 · 一码即用
              </p>

              <div className="flex" style={{ gap: 14, justifyContent: 'center' }}>
                <ShowcaseCard size={140} radius={22} image={CARD_IMAGES[0]} kind="play" delay={0.55} />
                <ShowcaseCard size={140} radius={22} image={CARD_IMAGES[1]} kind="number" delay={0.55} />
                <ShowcaseCard size={140} radius={22} image={CARD_IMAGES[2]} kind="play" delay={0.55} />
              </div>
            </div>

            {/* --- Desktop layout --- */}
            <div
              style={{ position: 'absolute', inset: 0, display: isMobile ? 'none' : 'block' }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  opacity: uiVisible ? 1 : 0,
                  transform: uiVisible ? 'translateY(0)' : 'translateY(16px)',
                  transition: 'opacity 0.9s ease, transform 0.9s ease',
                  transitionDelay: '0.3s',
                }}
              >
                <Scene1HeadingDesktop />
              </div>

              <div
                style={{
                  position: 'absolute',
                  right: 40,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  display: 'flex',
                  gap: 12,
                  opacity: uiVisible ? 1 : 0,
                  transition: 'opacity 0.9s ease',
                  transitionDelay: '0.55s',
                }}
              >
                <ShowcaseCard size={158} radius={28} image={CARD_IMAGES[0]} kind="play" delay={0} />
                <ShowcaseCard size={158} radius={28} image={CARD_IMAGES[1]} kind="number" delay={0} />
                <ShowcaseCard size={158} radius={28} image={CARD_IMAGES[2]} kind="play" delay={0} />
              </div>
            </div>

            {/* --- Slider Dots --- */}
            <div
              style={{
                position: 'absolute',
                bottom: 28,
                left: 0,
                right: 0,
                display: isMobile ? 'flex' : 'none',
                justifyContent: 'center',
                gap: 6,
                opacity: uiVisible ? 1 : 0,
                transform: uiVisible ? 'translateY(0)' : 'translateY(8px)',
                transition: 'opacity 0.9s ease, transform 0.9s ease',
                transitionDelay: '0.8s',
              }}
            >
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    width: i === 0 ? 28 : 14,
                    height: 4,
                    borderRadius: 2,
                    background:
                      i === 0 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)',
                  }}
                />
              ))}
            </div>
            <div
              style={{
                position: 'absolute',
                bottom: 40,
                left: 60,
                display: isMobile ? 'none' : 'flex',
                gap: 6,
                opacity: uiVisible ? 1 : 0,
                transform: uiVisible ? 'translateY(0)' : 'translateY(8px)',
                transition: 'opacity 0.9s ease, transform 0.9s ease',
                transitionDelay: '0.8s',
              }}
            >
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    width: i === 0 ? 28 : 14,
                    height: 4,
                    borderRadius: 2,
                    background:
                      i === 0 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)',
                  }}
                />
              ))}
            </div>

            {/* --- Scroll Cue (desktop only) --- */}
            <div
              style={{
                position: 'absolute',
                bottom: 36,
                left: 0,
                right: 0,
                display: isMobile ? 'none' : 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                opacity: uiVisible ? 1 : 0,
                transform: uiVisible ? 'translateY(0)' : 'translateY(8px)',
                transition: 'opacity 0.9s ease, transform 0.9s ease',
                transitionDelay: '0.9s',
              }}
            >
              <span
                style={{
                  fontFamily: "'Imprima', sans-serif",
                  fontSize: 10,
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                  color: 'rgba(255,255,255,0.6)',
                }}
              >
                Descend
              </span>
              <ScrollChevron />
            </div>
          </div>

          {/* === FEATURE CARDS (参考 Bloom 的三张玻璃能力卡) === */}
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: `translate(-50%, calc(-50% + ${lerp(44, -18, featureSceneOpacity)}px))`,
              width: isMobile ? 'calc(100% - 48px)' : 'max-content',
              maxWidth: '95%',
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 280px)',
              justifyContent: 'center',
              gap: 16,
              zIndex: 46,
              pointerEvents: 'none',
              opacity: featureSceneOpacity,
              transition: 'opacity .2s',
            }}
          >
            {[
              {
                title: '动效提示词库',
                desc: '精选 React、Tailwind、滚动叙事和交互页面提示词，直接进入可执行创作。',
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M4 6h16M4 12h10M4 18h16" strokeLinecap="round" />
                  </svg>
                ),
              },
              {
                title: 'AI 灵感集合',
                desc: '标题、分类、摘要和完整提示词分层管理，会员才可读取正文。',
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12 3v18M3 12h18" strokeLinecap="round" />
                    <circle cx="12" cy="12" r="7" />
                  </svg>
                ),
              },
              {
                title: 'IMG / VID AI',
                desc: '图像与视频生成灵感独立成库，封面预览和提示词内容各归其位。',
                icon: (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 5v14l11-7Z" strokeLinejoin="round" />
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                  </svg>
                ),
              },
            ].map((feature, index) => {
              const cardOpacity = clamp((featureSceneOpacity - index * 0.12) / 0.7, 0, 1);
              return (
                <div
                  key={feature.title}
                  style={{
                    width: isMobile ? '100%' : 280,
                    minHeight: isMobile ? 196 : 440,
                    padding: isMobile ? 24 : 28,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    justifyContent: 'flex-start',
                    borderRadius: 0,
                    background: 'rgba(255,255,255,.16)',
                    backdropFilter: 'blur(80px)',
                    WebkitBackdropFilter: 'blur(80px)',
                    border: '1px solid rgba(255,255,255,.15)',
                    boxShadow: '0 30px 60px rgba(0,0,0,.30)',
                    color: '#fff',
                    opacity: cardOpacity,
                    transform: `translateY(${lerp(34, 0, cardOpacity)}px)`,
                  }}
                >
                  <div
                    style={{
                      width: isMobile ? 38 : 48,
                      height: isMobile ? 38 : 48,
                      color: '#CB8DFF',
                      marginBottom: isMobile ? 24 : 32,
                    }}
                  >
                    {feature.icon}
                  </div>
                  <div style={{ flex: 1 }} />
                  <h3
                    style={{
                      fontFamily: "'Viaoda Libre', 'PingFang SC', serif",
                      fontSize: isMobile ? 23 : 28,
                      fontWeight: 400,
                      lineHeight: 1.15,
                      color: '#fff',
                      margin: '0 0 10px',
                      letterSpacing: 0,
                    }}
                  >
                    {feature.title}
                  </h3>
                  <p
                    style={{
                      fontFamily: "'Imprima', 'PingFang SC', sans-serif",
                      fontSize: isMobile ? 13 : 14,
                      lineHeight: 1.65,
                      color: 'rgba(255,255,255,.64)',
                      margin: 0,
                      letterSpacing: 0,
                    }}
                  >
                    {feature.desc}
                  </p>
                </div>
              );
            })}
          </div>

          {/* === SCENE 2 UI (滚动前半段：营销文案 + 数字证据) === */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 46,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              textAlign: 'center',
              padding: isMobile ? '0 24px' : '0 48px',
              opacity: scene2Opacity,
              pointerEvents: 'none',
              transform: `translateY(${lerp(34, -8, scene2Opacity)}px)`,
              transition: 'opacity .2s, transform .2s',
            }}
          >
            <div
              style={{
                fontFamily: "'Viaoda Libre', serif",
                fontSize: isMobile ? 'clamp(30px, 9vw, 48px)' : 'clamp(52px, 5.2vw, 76px)',
                color: '#fff',
                letterSpacing: 0,
                lineHeight: 1.22,
                textShadow: '0 2px 20px rgba(0,0,0,0.4)',
                maxWidth: 980,
              }}
            >
              我把散落的灵感整理成
              <span
                style={{
                  display: 'inline-block',
                  margin: isMobile ? '0 7px' : '0 12px',
                  padding: isMobile ? '2px 14px' : '4px 24px',
                  borderRadius: 999,
                  background: '#CB8DFF',
                  color: '#fff',
                  fontStyle: 'italic',
                }}
              >
                可直接使用
              </span>
              的提示词资产
            </div>
            <p
              style={{
                fontFamily: "'Imprima', 'PingFang SC', sans-serif",
                fontSize: isMobile ? 13 : 16,
                lineHeight: 1.6,
                letterSpacing: 0,
                color: 'rgba(255,255,255,0.82)',
                maxWidth: isMobile ? 310 : 560,
                margin: isMobile ? '18px 0 22px' : '24px 0 34px',
              }}
            >
              价格尽量压低，但整理、校验、分类和维护都是真实成本。这里卖的不是一堆乱文本，而是帮你节省试错时间的创作入口。
            </p>
            <div
              style={{
                display: 'flex',
                gap: isMobile ? 14 : 40,
                flexWrap: 'wrap',
                justifyContent: 'center',
                maxWidth: 640,
              }}
            >
              {[
                { num: '253', label: '精选提示词' },
                { num: '320+', label: '付费用户' },
                { num: '98%', label: '复购率' },
                { num: '10min', label: '交付时效' },
              ].map((s) => (
                <div
                  key={s.label}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    minWidth: isMobile ? 56 : 84,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'Viaoda Libre', serif",
                      fontSize: isMobile ? 26 : 38,
                      color: '#fde68a',
                      lineHeight: 1,
                      textShadow: '0 2px 14px rgba(253,230,138,0.3)',
                    }}
                  >
                    {s.num}
                  </div>
                  <div
                    style={{
                      fontFamily: "'Imprima', 'PingFang SC', sans-serif",
                      fontSize: isMobile ? 10 : 11,
                      letterSpacing: '0.12em',
                      textTransform: 'uppercase',
                      color: 'rgba(255,255,255,0.6)',
                    }}
                  >
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* === LOGIN PANEL (滚动 50% 后浮现，固定右下角) === */}
          <LoginPanel visible={loginVisible} isMobile={isMobile} />
        </div>
      </div>
      <TutorialModal open={tutorialOpen} onClose={() => setTutorialOpen(false)} isMobile={isMobile} />
      {styleEl ? null : null}
    </>
  );
}

export default function App() {
  const isMobile = useIsMobile();
  const [tutorialOpen, setTutorialOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && data.ok) location.replace('/');
      })
      .catch(() => { /* stay on login */ });
    return () => { cancelled = true; };
  }, []);

  const featureItems = [
    { value: 'MotionSites', label: '动效网页提示词' },
    { value: 'IMG AI', label: '图片生成灵感' },
    { value: 'VID AI', label: '视频生成灵感' },
  ];

  return (
    <>
      <main
        style={{
          minHeight: '100svh',
          position: 'relative',
          overflow: 'hidden',
          background: '#06080f',
          color: '#fff',
          fontFamily: "'Barlow', 'PingFang SC', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <video
          aria-hidden="true"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          src={LOGIN_HERO_VIDEO}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: 0.74,
            filter: 'saturate(1.08) contrast(1.05)',
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(90deg, rgba(4,8,17,0.82) 0%, rgba(4,8,17,0.54) 42%, rgba(4,8,17,0.42) 100%), linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.12) 42%, rgba(0,0,0,0.62) 100%)',
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(circle at 24% 28%, rgba(203,141,255,0.2), transparent 30%), radial-gradient(circle at 76% 62%, rgba(90,180,255,0.16), transparent 32%)',
            mixBlendMode: 'screen',
          }}
        />

        <header
          style={{
            position: 'relative',
            zIndex: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 16,
            width: 'min(1180px, calc(100% - 32px))',
            margin: '0 auto',
            padding: isMobile ? '18px 0 10px' : '24px 0',
          }}
        >
          <BrandDot />
        </header>

        <section
          style={{
            position: 'relative',
            zIndex: 3,
            width: 'min(1180px, calc(100% - 32px))',
            minHeight: isMobile ? 'auto' : 'calc(100svh - 108px)',
            margin: '0 auto',
            padding: isMobile ? '18px 0 34px' : '32px 0 54px',
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.1fr) minmax(390px, 450px)',
            alignItems: 'center',
            gap: isMobile ? 26 : 56,
          }}
        >
          <div style={{ maxWidth: 680 }}>
            <div
              className="liquid-glass"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 999,
                color: 'rgba(255,255,255,0.86)',
                fontSize: 12,
                fontWeight: 600,
                marginBottom: isMobile ? 22 : 28,
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 20,
                  padding: '0 8px',
                  borderRadius: 999,
                  background: 'rgba(203,141,255,0.28)',
                  color: '#fff',
                  fontSize: 11,
                }}
              >
                New
              </span>
              MotionSites / AI / IMG / VID 灵感库已整理上线
            </div>

            <h1
              style={{
                margin: 0,
                maxWidth: 760,
                fontFamily: "'Instrument Serif', 'Noto Serif SC', 'Songti SC', serif",
                fontSize: isMobile ? 48 : 84,
                lineHeight: isMobile ? 0.98 : 0.94,
                fontWeight: 400,
                letterSpacing: 0,
                textWrap: 'balance',
              }}
            >
              把提示词灵感变成
              <span style={{ display: 'block', fontStyle: 'italic', color: '#f3d7ff' }}>
                可直接使用的创作资产
              </span>
            </h1>

            <p
              style={{
                margin: isMobile ? '20px 0 24px' : '28px 0 34px',
                maxWidth: 610,
                color: 'rgba(255,255,255,0.78)',
                fontSize: isMobile ? 15 : 17,
                lineHeight: 1.75,
                letterSpacing: 0,
              }}
            >
              这里整理的是 MotionSites 动效网页、AI 灵感库、图片生成与视频生成提示词。注册后进入内容库，会员可查看完整正文、复制使用，并持续获得新增内容。
            </p>

            <div
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                alignItems: 'center',
                marginBottom: isMobile ? 24 : 36,
              }}
            >
              <a
                href="#login"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 48,
                  padding: '0 22px',
                  borderRadius: 999,
                  background: '#fff',
                  color: '#10131b',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 800,
                  boxShadow: '0 22px 48px rgba(255,255,255,0.18)',
                }}
              >
                登录解锁
              </a>
              <button
                type="button"
                onClick={() => setTutorialOpen(true)}
                className="liquid-glass"
                style={{
                  minHeight: 48,
                  padding: '0 20px',
                  borderRadius: 999,
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                查看教程
              </button>
            </div>

            <div
              style={{
                display: isMobile ? 'none' : 'grid',
                gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))',
                gap: 10,
                maxWidth: 660,
              }}
            >
              {featureItems.map((item) => (
                <div
                  key={item.value}
                  className="liquid-glass"
                  style={{
                    borderRadius: 18,
                    padding: '14px 16px',
                    minHeight: 78,
                  }}
                >
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#fff', marginBottom: 4 }}>
                    {item.value}
                  </div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'rgba(255,255,255,0.64)' }}>
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div id="login" className="liquid-glass-strong" style={{ borderRadius: 26, padding: isMobile ? 10 : 12 }}>
            <LoginPanel visible={true} isMobile={isMobile} embedded />
          </div>
        </section>
      </main>
      <TutorialModal open={tutorialOpen} onClose={() => setTutorialOpen(false)} isMobile={isMobile} />
    </>
  );
}
