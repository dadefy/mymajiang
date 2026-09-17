import type { PointLedgerEntry, UserAccount } from "@mianyang-mahjong/domain";

/**
 * Statement fragments shared by every repository.
 *
 * They exist so one transaction can write an account row together with the ledger row that
 * explains it: the administrator repository pairs them with a manual adjustment, the room
 * repository pairs them with a match settlement. Keeping the SQL in one place means the column
 * order and the parameter order can never drift apart between the two callers.
 */

export const UPSERT_ACCOUNT_SQL = `INSERT INTO users (
    user_id, invitation_key_hash, nickname, avatar_url, status, points,
    active_match_id, created_at, password_hash, updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    nickname = EXCLUDED.nickname, avatar_url = EXCLUDED.avatar_url,
    status = EXCLUDED.status, points = EXCLUDED.points, password_hash = EXCLUDED.password_hash,
    active_match_id = EXCLUDED.active_match_id, updated_at = NOW()`;

export function accountParameters(account: UserAccount): readonly unknown[] {
  return [
    account.userId,
    // 建立账号时用过的邀请密钥哈希；不带密钥建号（管理员手工建号）时为空。
    // 冲突时不更新这一列：密钥与账号的绑定是不可变的。
    account.invitationKeyHash ?? null,
    account.nickname,
    account.avatarUrl,
    account.status,
    account.points,
    account.activeMatchId ?? null,
    account.createdAt,
    account.passwordHash ?? null,
  ];
}

// `delta` is never zero, so a settled player whose capped delta is zero simply has no ledger row.
export const INSERT_POINT_LEDGER_SQL = `INSERT INTO point_ledger (
    ledger_id, user_id, entry_type, delta, balance_before, balance_after,
    reason, actor_id, room_id, reversal_of, created_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

export function ledgerParameters(entry: PointLedgerEntry): readonly unknown[] {
  return [
    entry.ledgerId,
    entry.userId,
    entry.type,
    entry.delta,
    entry.balanceBefore,
    entry.balanceAfter,
    entry.reason,
    entry.actorId,
    entry.roomId ?? null,
    entry.reversalOf ?? null,
    entry.createdAt,
  ];
}
