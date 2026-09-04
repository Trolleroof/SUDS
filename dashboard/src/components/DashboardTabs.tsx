"use client";

import Link from "next/link";

export type DashboardTab = "live" | "collect" | "review";

/**
 * Live and Review stay on `/` (client state). Collect is its own route so the
 * handheld wrist camera can come up without the recorder or a full arm.
 */
export default function DashboardTabs({
  current,
  liveDot,
  reviewCount,
  onLive,
  onReview,
}: {
  current: DashboardTab;
  liveDot?: "ok" | "fail" | null;
  reviewCount?: number;
  onLive?: () => void;
  onReview?: () => void;
}) {
  return (
    <div className="tabs">
      {onLive ? (
        <button type="button" className="tab" aria-pressed={current === "live"} onClick={onLive}>
          Live
          {liveDot && <span className={`dot ${liveDot}`} aria-hidden />}
        </button>
      ) : (
        <Link href="/" className="tab" aria-pressed={current === "live"}>
          Live
        </Link>
      )}
      <Link href="/collect" className="tab" aria-pressed={current === "collect"}>
        Collect
      </Link>
      {onReview ? (
        <button type="button" className="tab" aria-pressed={current === "review"} onClick={onReview}>
          Review
          {reviewCount != null && <span className="tab-count">{reviewCount}</span>}
        </button>
      ) : (
        <Link href="/?view=review" className="tab" aria-pressed={current === "review"}>
          Review
        </Link>
      )}
    </div>
  );
}
