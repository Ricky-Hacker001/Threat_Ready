import type { AppInfo } from "@threatready/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { appHref } from "./Platform";

export interface ProfileUser {
  name?: string | null;
  email?: string | null;
  username?: string | null;
  image?: string | null;
}

/** Best label for a person: display name, then username, then email. */
export function displayName(u: ProfileUser): string {
  return u.name?.trim() || u.username || u.email || "Your account";
}

function initials(u: ProfileUser): string {
  const src = u.name?.trim() || u.username || u.email?.split("@")[0] || "?";
  const words = src.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : src.slice(0, 2);
  return letters.toUpperCase();
}

/** Provider photo when there is one; initials otherwise or if the photo fails to load. */
export function Avatar({ user, size = 32 }: { user: ProfileUser; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (user.image && !broken) {
    return (
      <img
        className="avatar"
        src={user.image}
        alt=""
        style={style}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="avatar avatar-initials" style={style} aria-hidden="true">
      {initials(user)}
    </span>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg className="tr-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);

/**
 * The account menu in the top bar (same markup as Labs and Attack Reasoning).
 * On small screens the inline app switcher is hidden, so this menu also lists
 * the apps: there is always a way from any app to every other one.
 */
export function ProfileMenu({
  user,
  isAdmin,
  apps,
  current,
  signingOut,
  onSignOut,
}: {
  user: ProfileUser;
  isAdmin?: boolean;
  apps: AppInfo[];
  current: "home" | "profile" | "admin";
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = displayName(user);
  const close = () => setOpen(false);
  return (
    <div className="tr-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="tr-menu-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar user={user} size={28} />
        <span className="tr-user-name">{name}</span>
        <svg className="tr-chev" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="visually-hidden">Account and apps menu</span>
      </button>
      {open ? (
        <div className="tr-menu-pop" id={menuId}>
          <div className="tr-menu-head">
            <Avatar user={user} size={36} />
            <div>
              <strong>{name}</strong>
              {user.email && user.email !== name ? <span>{user.email}</span> : null}
            </div>
          </div>
          <div className="tr-menu-apps">
            <span className="tr-menu-label">Apps</span>
            <Link className="tr-menu-item" to="/app" aria-current={current === "home" ? "page" : undefined} onClick={close}>
              <Icon d="M4 11l8-7 8 7v9a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1z" />
              Home
            </Link>
            {apps.map((a) =>
              a.status === "live" ? (
                <a key={a.key} className="tr-menu-item" href={appHref(a)}>
                  <span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />
                  {a.title}
                </a>
              ) : (
                <span key={a.key} className="tr-menu-item" aria-disabled="true">
                  <span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />
                  {a.title}
                  <span className="tr-tag tr-tag-soon tr-tag-plain">Soon</span>
                </span>
              ),
            )}
            <div className="tr-menu-sep" />
          </div>
          <Link className="tr-menu-item" to="/app/profile" aria-current={current === "profile" ? "page" : undefined} onClick={close}>
            <Icon d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c1-4 4-6 8-6s7 2 8 6" />
            Profile and progress
          </Link>
          {isAdmin ? (
            <Link className="tr-menu-item" to="/app/admin" aria-current={current === "admin" ? "page" : undefined} onClick={close}>
              <Icon d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
              Admin console
            </Link>
          ) : null}
          <div className="tr-menu-sep" />
          <button type="button" className="tr-menu-item" disabled={signingOut} aria-busy={signingOut || undefined} onClick={onSignOut}>
            <Icon d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
