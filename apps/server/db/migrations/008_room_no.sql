-- 6 位数字房间号：给人念、给人输的那串。内部标识仍然是 room_id（UUID），
-- 两者分开 —— 让人口头转述或手输一串 UUID 不现实，而房间号要能在一句话里说清楚。
-- 与群聊 8 位群号（chat_groups.group_no）是同一套做法。

ALTER TABLE match_rooms ADD COLUMN IF NOT EXISTS room_no CHAR(6);

-- 历史行补号：按创建顺序发号，从 100000 起，保证互不相同。
UPDATE match_rooms AS room
   SET room_no = lpad((((numbered.seq - 1) % 900000) + 100000)::text, 6, '0')
  FROM (
    SELECT room_id, row_number() OVER (ORDER BY created_at ASC, room_id ASC) AS seq
      FROM match_rooms
     WHERE room_no IS NULL
  ) AS numbered
 WHERE room.room_id = numbered.room_id;

-- 补号之后就没有空值了；库里本来也可能一条房间都没有。
ALTER TABLE match_rooms ALTER COLUMN room_no SET NOT NULL;

-- 唯一性只约束「还在用的房间」：房间打完号码就该释放，
-- 而结束的房间行会一直留着做历史，不该继续占号。
-- 唯一的房间号只在服务端内存里比对（`nextRoomNo`），这个索引是兜底：
-- 真撞上时插入直接失败并报错，比悄悄开出两个同号房间好。
CREATE UNIQUE INDEX IF NOT EXISTS match_rooms_active_room_no
  ON match_rooms (room_no)
  WHERE status IN ('waiting', 'playing');
