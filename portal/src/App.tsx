import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FocusEventHandler } from 'react';

/* ============================================================
   BRAND
   ============================================================ */
const BRAND = 'Prompt Vault';
const TAGLINE = '解锁 Prompt › 灵感库';

/* ============================================================
   HERO BACKGROUND (沉浸感背景)
   使用项目自带的占位图 manghe.png 与 portal 视觉一致的渐变叠加。
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

const MAG = { world: 6, clouds: 9, portal: 7, curtainL: 14, curtainR: 14 } as const;

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
        gap: 8,
        fontFamily: "'Imprima', 'PingFang SC', sans-serif",
        fontSize: 14,
        fontWeight: 700,
        letterSpacing: '0.04em',
        color: '#fff',
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #6366f1, #f472b6)',
          boxShadow: '0 0 12px rgba(99,102,241,0.6)',
        }}
      />
      <span>Prompt Vault</span>
    </span>
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
          top: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          padding: '18px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div
          style={{
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <a href="#vault" style={navLinkStyle(11)}>灵感</a>
          <BrandDot />
          <a
            href="#login"
            onClick={(e) => { e.preventDefault(); onJumpToLogin(); }}
            style={navLinkStyle(11)}
          >登录</a>
        </div>
        <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
          <TutorialBadge onClick={onOpenTutorial} compact />
        </div>
      </nav>
    );
  }
  return (
    <nav
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        padding: '22px 48px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', gap: 36, alignItems: 'center' }}>
        <a href="#vault" style={navLinkStyle(12)}>灵感库</a>
        <a href="#value" style={navLinkStyle(12)}>价值</a>
        <a
          href="#login"
          onClick={(e) => { e.preventDefault(); onJumpToLogin(); }}
          style={navLinkStyle(12)}
        >登录</a>
      </div>
      <BrandDot />
      <div style={{ display: 'flex', gap: 36, alignItems: 'center' }}>
        <a href="#vault" style={navLinkStyle(12)}>动效</a>
        <a href="#value" style={navLinkStyle(12)}>为什么</a>
        <TutorialBadge onClick={onOpenTutorial} />
        <a
          href="#login"
          onClick={(e) => { e.preventDefault(); onJumpToLogin(); }}
          style={{ ...navLinkStyle(12), cursor: 'pointer' }}
        >解锁 →</a>
      </div>
    </nav>
  );
}

function navLinkStyle(fontSize: number): CSSProperties {
  return {
    fontFamily: "'Imprima', sans-serif",
    fontSize,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: '#fff',
    opacity: 0.9,
    textDecoration: 'none',
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
        top: '46%',
        left: 60,
        transform: 'translateY(-50%)',
        maxWidth: 460,
        textShadow: '0 2px 24px rgba(0,0,0,0.7), 0 1px 4px rgba(0,0,0,0.9)',
        color: '#fff',
      }}
    >
      <div
        style={{
          fontFamily: "'Viaoda Libre', serif",
          fontSize: 'clamp(30px, 4vw, 46px)',
          lineHeight: 1.1,
          letterSpacing: '0.04em',
        }}
      >
        解锁 PROMPT <span style={{ color: 'rgba(255,220,180,0.85)' }}>›</span> 灵感库
      </div>
      <div
        style={{
          fontFamily: "'Viaoda Libre', serif",
          fontSize: 'clamp(54px, 8vw, 96px)',
          lineHeight: 0.9,
          letterSpacing: '-0.02em',
          marginTop: 6,
        }}
      >
        PROMPT<br/>VAULT
      </div>
      <p
        style={{
          marginTop: 24,
          fontFamily: "'Imprima', 'PingFang SC', sans-serif",
          fontSize: 17,
          lineHeight: 1.7,
          color: 'rgba(255,245,235,0.88)',
          maxWidth: 320,
          textShadow: '0 1px 12px rgba(0,0,0,0.8)',
        }}
      >
        253 套 React + Tailwind 动效提示词，不定期更新，令君设计常新，先声夺人。
      </p>
      <div
        style={{
          marginTop: 18,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          borderRadius: 999,
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.18)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          color: '#fff',
          fontFamily: "'Imprima', 'PingFang SC', sans-serif",
          fontSize: 12,
          letterSpacing: '0.06em',
          textShadow: '0 1px 8px rgba(0,0,0,0.6)',
        }}
      >
        <span style={{ color: '#fde68a' }}>★</span>
        <span>已交付 <b style={{ color: '#fde68a' }}>320+</b> 位匠人  ·  嘉评如潮 <b style={{ color: '#fde68a' }}>98%</b></span>
      </div>
    </div>
  );
}

function Scene1HeadingMobile() {
  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          fontFamily: "'Viaoda Libre', serif",
          fontSize: 'clamp(22px, 6vw, 36px)',
          letterSpacing: '0.18em',
          color: '#3b1a0a',
        }}
      >
        解锁 PROMPT <span style={{ color: '#6b2e0e', fontSize: '0.8em' }}>›</span> 灵感库
      </div>
      <div
        style={{
          fontFamily: "'Viaoda Libre', serif",
          fontStyle: 'italic',
          fontSize: 'clamp(46px, 14vw, 72px)',
          letterSpacing: '-0.02em',
          lineHeight: 1,
          color: '#3b1a0a',
          marginTop: 2,
        }}
      >
        VAULT
      </div>
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
        color: '#5c2d0e',
        maxWidth: 280,
        textAlign: 'center',
        margin: '0 auto',
      }}
    >
      253 套 React + Tailwind 动效提示词，不定期更新，令君设计常新，先声夺人。
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
type HoneypotState = {
  website: string;
  contact_method: string;
};

function LoginPanel({
  visible,
  isMobile,
}: {
  visible: boolean;
  isMobile: boolean;
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
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', mode === 'password' ? location.pathname + location.search : location.pathname + location.search + '#' + mode);
    }
  }, [mode]);

  // ----- Common error/result translator -----
  function applyResponseError(
    data: {
      ok?: boolean; error?: string; message?: string; reasons?: string[];
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
      fetch('/api/captcha/new').then(r => r.json()).then(d => { if (d.ok) setCaptcha(d); }).catch(() => {});
      return;
    }
    if (data.error === 'device_limit') {
      setDeviceLimit({ existing_devices: data.existing_devices || [] });
      setError(data.message || '设备已达上限');
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
      if (d.ok) setCaptcha(d);
    } catch { /* ignore */ }
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
      <div style={{ marginBottom: 16, padding: 12, background: 'rgba(99,102,241,.08)', border: '1px solid rgba(99,102,241,.35)', borderRadius: 12 }}>
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
          type="text"
          inputMode="numeric"
          placeholder="请输入图中的数学答案"
          value={captchaAnswer}
          onChange={(e) => setCaptchaAnswer(e.target.value)}
          style={{
            marginTop: 8, width: '100%', padding: '10px 12px',
            background: 'rgba(10,10,15,0.7)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10, color: '#fff', fontSize: 14, outline: 'none',
            boxSizing: 'border-box',
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
    color: 'rgba(255,255,255,0.55)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom: 6,
  };
  const baseInputStyle: CSSProperties = {
    width: '100%',
    padding: '12px 14px',
    background: 'rgba(10,10,15,0.7)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12,
    color: '#fff',
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
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
        e.currentTarget.style.borderColor = '#818cf8';
        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(99,102,241,0.22)';
      } else {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
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

  const cardW = isMobile ? 'min(94vw, 460px)' : 480;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        pointerEvents: visible ? 'auto' : 'none',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(40px)',
        transition: 'opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <div
        style={{
          width: cardW,
          padding: isMobile ? '22px 20px' : '28px 28px',
          borderRadius: 22,
          background: 'rgba(20, 18, 24, 0.78)',
          backdropFilter: 'blur(22px) saturate(140%)',
          WebkitBackdropFilter: 'blur(22px) saturate(140%)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04) inset',
          color: '#fff',
          fontFamily: "'Imprima', 'PingFang SC', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #6366f1, #f472b6)',
              boxShadow: '0 0 12px rgba(99,102,241,0.7)',
            }}
          />
          <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>
            {BRAND}
          </span>
        </div>

        {/* Heading */}
        <div
          style={{
            fontFamily: "'Viaoda Libre', serif",
            fontSize: isMobile ? 26 : 30,
            lineHeight: 1.15,
            letterSpacing: '-0.01em',
            marginBottom: 4,
          }}
        >
          进入灵感之匣
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.6,
            color: 'rgba(255,255,255,0.7)',
            marginBottom: 16,
          }}
        >
          使用账号密码进入；没有邀请码也可以直接注册。
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          style={{
            display: 'flex',
            gap: 4,
            padding: 4,
            borderRadius: 12,
            background: 'rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.08)',
            marginBottom: 18,
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
                  padding: isMobile ? '8px 4px' : '10px 12px',
                  fontSize: isMobile ? 12 : 13,
                  fontWeight: 600,
                  letterSpacing: '0.02em',
                  border: 'none',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: active ? '#fff' : 'rgba(255,255,255,0.55)',
                  background: active
                    ? 'linear-gradient(135deg, rgba(99,102,241,0.85), rgba(244,114,182,0.85))'
                    : 'transparent',
                  boxShadow: active ? '0 6px 18px -8px rgba(99,102,241,0.7)' : 'none',
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
            <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, marginBottom: 14 }}>
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
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8, color: 'rgba(255,255,255,0.75)',
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
                width: '100%', padding: '13px 16px',
                background: submitting ? 'linear-gradient(135deg, #4f46e5, #db2777)' : 'linear-gradient(135deg, #6366f1, #f472b6)',
                color: '#fff', border: 'none', borderRadius: 12,
                fontWeight: 600, fontSize: 15,
                cursor: submitting ? 'wait' : 'pointer',
                opacity: submitting ? 0.85 : 1,
                boxShadow: '0 10px 30px -10px rgba(99,102,241,0.6)',
              }}
            >
              {submitting ? '登录中…' : '登录 →'}
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
            <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, marginBottom: 14 }}>
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
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8, color: 'rgba(255,255,255,0.75)',
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
                width: '100%', padding: '13px 16px',
                background: submitting ? 'linear-gradient(135deg, #4f46e5, #db2777)' : 'linear-gradient(135deg, #6366f1, #f472b6)',
                color: '#fff', border: 'none', borderRadius: 12,
                fontWeight: 600, fontSize: 15,
                cursor: submitting ? 'wait' : 'pointer',
                opacity: submitting ? 0.85 : 1,
                boxShadow: '0 10px 30px -10px rgba(99,102,241,0.6)',
              }}
            >
              {submitting ? '注册中…' : '注册并登录 →'}
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
export default function App() {
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
    const target = total * 0.58;
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
  const scene1Opacity = clamp(1 - scrollProgress / 0.22, 0, 1);
  // Scene 2 (营销文案) 在 0.30-0.50 区间淡入淡出
  const scene2Opacity = clamp((scrollProgress - 0.30) / 0.18, 0, 1) *
                        (1 - clamp((scrollProgress - 0.50) / 0.05, 0, 1));
  // Login 面板在滚动到 ~50% 时浮现，完全可见在 60%+
  const loginVisible = scrollProgress >= 0.50;
  // 顶部滚动提示：仅在用户尚未滚动时显示，开始滚动后淡出
  const scrollHintVisible = scrollProgress < 0.05;
  const arcSweepDeg = (ARC_CARDS.length - 1) * 10;
  const arcRotation = lerp(0, arcSweepDeg, clamp((scrollProgress - 0.7) / 0.3, 0, 1));

  const cloudsOpacity = clamp(lerp(0.7, 1, scrollProgress / 0.05), 0.7, 1);
  const portalOpacity = scrollProgress < 0.65 ? 1 : scrollProgress >= 0.85 ? 0 : 1 - (scrollProgress - 0.65) / 0.2;

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
        style={{ height: '200vh', position: 'relative', background: '#0a0608' }}
      >
        <div
          style={{
            position: 'sticky',
            top: 0,
            height: '100vh',
            overflow: 'hidden',
            background: '#0a0608',
          }}
        >
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
              opacity: scene2Opacity,
              pointerEvents: 'none',
              height: 0,
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
            <img
              src={BOTTOM_CLOUDS}
              alt=""
              style={{ width: '100%', height: 'auto', display: 'block' }}
            />
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
            <img
              src={CURTAIN_LEFT}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'right center',
              }}
            />
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
            <img
              src={CURTAIN_RIGHT}
              alt=""
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'left center',
              }}
            />
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
              pointerEvents: scene1Opacity > 0.02 ? 'auto' : 'none',
            }}
          >
            {/* --- Mobile layout --- */}
            <div
              className="md:hidden"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
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
              className="hidden md:flex xl:hidden"
              style={{
                position: 'absolute',
                inset: 0,
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
                    color: '#3b1a0a',
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
                    color: '#3b1a0a',
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
                  color: '#5c2d0e',
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
              className="hidden xl:block"
              style={{ position: 'absolute', inset: 0 }}
            >
              <div
                style={{
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
              className="md:hidden"
              style={{
                position: 'absolute',
                bottom: 28,
                left: 0,
                right: 0,
                display: 'flex',
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
              className="hidden md:block"
              style={{
                position: 'absolute',
                bottom: 40,
                left: 60,
                display: 'flex',
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
              className="hidden md:flex"
              style={{
                position: 'absolute',
                bottom: 36,
                left: 0,
                right: 0,
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

          {/* === SCENE 2 UI (滚动前半段：营销文案 + 数字证据) === */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 46,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
              textAlign: 'center',
              padding: isMobile ? '14vh 24px 0' : '10vh 24px 0',
              opacity: scene2Opacity,
              pointerEvents: scene2Opacity > 0.02 ? 'auto' : 'none',
              transition: 'opacity .2s',
            }}
          >
            <div
              style={{
                fontFamily: "'Viaoda Libre', serif",
                fontSize: isMobile ? 'clamp(22px, 6vw, 32px)' : 'clamp(28px, 4vw, 50px)',
                color: '#fff',
                letterSpacing: '0.03em',
                lineHeight: 1.1,
                textShadow: '0 2px 20px rgba(0,0,0,0.4)',
                marginBottom: 10,
              }}
            >
              缘何独钟 Prompt Vault
            </div>
            <p
              style={{
                fontFamily: "'Imprima', 'PingFang SC', sans-serif",
                fontSize: isMobile ? 13 : 16,
                lineHeight: 1.6,
                letterSpacing: '-0.01em',
                color: 'rgba(255,255,255,0.82)',
                maxWidth: isMobile ? 280 : 480,
                marginBottom: isMobile ? 18 : 28,
              }}
            >
              非止模板之库 —— 乃 253 套已验之动效提示词，使君一刻之内，得成平日八时之功。
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
