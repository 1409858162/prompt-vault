// Membership expiry helpers.
//
// Rules (product):
//   - New invite codes carry `membership_years` (default 10). Clock starts on first login.
//   - Legacy codes (no membership_years, no expires_at) stay permanently valid.
//   - Promoted accounts inherit the invite code's membership window.
//   - Revoked codes/accounts are never members.
//   - Expired members may browse catalog metadata but not prompt bodies.

export const DEFAULT_MEMBERSHIP_YEARS = 10;

export function addYears(isoDate, years) {
  const d = new Date(isoDate);
  d.setFullYear(d.getFullYear() + Number(years));
  return d.toISOString();
}

/** Legacy codes created before membership_years existed — permanent access. */
export function isLegacyPermanent(entry) {
  if (!entry) return false;
  return entry.membership_years == null && !entry.expires_at;
}

export function needsActivation(entry) {
  if (!entry || entry.revoked) return false;
  if (isLegacyPermanent(entry)) return false;
  if (entry.membership_years == null) return false;
  return !entry.activated_at || !entry.expires_at;
}

/** Patch to apply on first login / registration activation. */
export function activationPatch(entry, at = new Date()) {
  if (!needsActivation(entry)) return null;
  const years = entry.membership_years ?? DEFAULT_MEMBERSHIP_YEARS;
  const activated_at = at.toISOString();
  return {
    activated_at,
    expires_at: addYears(activated_at, years),
  };
}

export function getMembershipStatus(entry, { revoked = false } = {}) {
  const empty = {
    is_member: false,
    is_permanent: false,
    expires_at: null,
    activated_at: null,
    membership_years: null,
    reason: 'not_found',
  };
  if (!entry) return empty;
  if (revoked || entry.revoked) {
    return {
      is_member: false,
      is_permanent: false,
      expires_at: entry.expires_at || null,
      activated_at: entry.activated_at || null,
      membership_years: entry.membership_years ?? null,
      reason: 'revoked',
    };
  }
  if (isLegacyPermanent(entry)) {
    return {
      is_member: true,
      is_permanent: true,
      expires_at: null,
      activated_at: entry.activated_at || null,
      membership_years: null,
      reason: 'legacy',
    };
  }
  if (!entry.expires_at) {
    // membership_years set but not yet activated — valid until first login sets expiry.
    return {
      is_member: true,
      is_permanent: false,
      expires_at: null,
      activated_at: null,
      membership_years: entry.membership_years ?? DEFAULT_MEMBERSHIP_YEARS,
      reason: 'pending_activation',
    };
  }
  const expired = new Date(entry.expires_at).getTime() <= Date.now();
  return {
    is_member: !expired,
    is_permanent: false,
    expires_at: entry.expires_at,
    activated_at: entry.activated_at || null,
    membership_years: entry.membership_years ?? null,
    reason: expired ? 'expired' : 'active',
  };
}

export function resolveAccountMembership(account, codeEntry) {
  const merged = {
    revoked: !!account?.revoked,
    membership_years: account?.membership_years ?? codeEntry?.membership_years ?? null,
    activated_at: account?.activated_at ?? codeEntry?.activated_at ?? null,
    expires_at: account?.expires_at ?? codeEntry?.expires_at ?? null,
  };
  return getMembershipStatus(merged, { revoked: !!account?.revoked });
}

export function formatExpiresLabel(status) {
  if (status.is_permanent) return '永久有效';
  if (!status.expires_at) {
    if (status.reason === 'pending_activation' && status.membership_years) {
      return `首次登录后 ${status.membership_years} 年`;
    }
    return '—';
  }
  const d = new Date(status.expires_at);
  if (isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `会员至 ${y}-${m}-${day}`;
}
