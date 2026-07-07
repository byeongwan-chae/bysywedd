const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// ── 알림 메시지 생성 헬퍼 ──────────────────────────────────────

function formatWon(amount) {
  return "₩" + Math.round(amount).toLocaleString("ko-KR");
}

/**
 * before/after 데이터를 비교해 알림 페이로드 목록을 반환한다.
 * 변경을 일으킨 사람(actor)은 caller 쪽에서 결정하므로 여기선 메시지만 만든다.
 * @returns {{ title: string, body: string, tag: string }[]}
 */
function buildNotifications(before, after) {
  const notifications = [];

  // ── 1. 체크리스트 체크 / 해제 ──────────────────────────────
  const beforeLastUpdate = before.lastUpdate || {};
  const afterLastUpdate = after.lastUpdate || {};

  for (const k of Object.keys(afterLastUpdate)) {
    const prev = beforeLastUpdate[k];
    const next = afterLastUpdate[k];
    if (!next) continue;

    const isNewCheck = !prev;
    const isActorChanged = prev && prev.by !== next.by;
    if (!isNewCheck && !isActorChanged) continue;

    // 항목 이름 추출 (key 형식: catId__itemId)
    const itemName = resolveItemName(k, after);
    const actor = next.by || "상대방";
    notifications.push({
      title: `${actor}님이 항목을 체크했어요`,
      body: itemName,
      tag: `check_${k}`,
    });
  }

  // 체크 해제 감지 (afterLastUpdate에 없는데 beforeLastUpdate에 있던 것)
  for (const k of Object.keys(beforeLastUpdate)) {
    if (afterLastUpdate[k]) continue;
    // checked에서도 빠진 경우만 (실제 해제)
    const afterChecked = after.checked || {};
    if (afterChecked[k]) continue;

    const actor = (beforeLastUpdate[k] && beforeLastUpdate[k].by) || "상대방";
    const itemName = resolveItemName(k, before);
    notifications.push({
      title: `${actor}님이 체크를 해제했어요`,
      body: itemName,
      tag: `uncheck_${k}`,
    });
  }

  // ── 2. 메모 추가 / 수정 ──────────────────────────────────────
  const beforeMemos = before.memos || {};
  const afterMemos = after.memos || {};

  for (const k of Object.keys(afterMemos)) {
    const prev = beforeMemos[k] || "";
    const next = afterMemos[k] || "";
    if (!next || prev === next) continue;

    const itemName = resolveItemName(k, after);
    const actor = resolveActorByKey(k, after);
    notifications.push({
      title: `${actor}님이 메모를 ${prev ? "수정" : "추가"}했어요`,
      body: itemName,
      tag: `memo_${k}`,
    });
  }

  // ── 3. 사진 추가 ──────────────────────────────────────────────
  const beforePhotos = before.photos || {};
  const afterPhotos = after.photos || {};

  for (const k of Object.keys(afterPhotos)) {
    const prevCount = (beforePhotos[k] || []).filter((p) => !p.uploading).length;
    const nextList = (afterPhotos[k] || []).filter((p) => !p.uploading);
    if (nextList.length <= prevCount) continue;

    const added = nextList.slice(prevCount);
    const actor = (added[0] && added[0].by) || "상대방";
    const itemName = resolveItemName(k, after);
    notifications.push({
      title: `${actor}님이 사진을 추가했어요`,
      body: `${itemName} (+${nextList.length - prevCount}장)`,
      tag: `photo_${k}`,
    });
  }

  // ── 4. 가계부 항목 추가 ──────────────────────────────────────
  const beforeEntries = (before.budget && before.budget.entries) || [];
  const afterEntries = (after.budget && after.budget.entries) || [];
  const beforeEntryIds = new Set(beforeEntries.map((e) => e.id));

  for (const entry of afterEntries) {
    if (beforeEntryIds.has(entry.id)) continue;
    const actor = entry.by || "상대방";
    const typeLabel = entry.type === "income" ? "수입" : "지출";
    notifications.push({
      title: `${actor}님이 가계부에 ${typeLabel}을 추가했어요`,
      body: `${entry.desc} ${formatWon(entry.amount)}`,
      tag: `budget_add_${entry.id}`,
    });
  }

  // 가계부 항목 삭제
  const afterEntryIds = new Set(afterEntries.map((e) => e.id));
  for (const entry of beforeEntries) {
    if (afterEntryIds.has(entry.id)) continue;
    notifications.push({
      title: "가계부 항목이 삭제되었어요",
      body: entry.desc,
      tag: `budget_del_${entry.id}`,
    });
  }

  // ── 5. 신혼여행 일정 추가 / 삭제 ────────────────────────────
  const beforeDays = (before.honeymoon && before.honeymoon.days) || [];
  const afterDays = (after.honeymoon && after.honeymoon.days) || [];

  // 기존 Day 전체 아이템 목록을 맵으로 만들기
  const beforeItemMap = new Map();
  for (const day of beforeDays) {
    for (const item of day.items || []) {
      beforeItemMap.set(item.id, item);
    }
  }

  for (const day of afterDays) {
    for (const item of day.items || []) {
      if (!beforeItemMap.has(item.id)) {
        notifications.push({
          title: "신혼여행 일정이 추가되었어요",
          body: `${item.time ? item.time + " " : ""}${item.place}`,
          tag: `hm_add_${item.id}`,
        });
      }
    }
  }

  // Day 자체가 추가된 경우
  const beforeDayIds = new Set(beforeDays.map((d) => d.id));
  for (const day of afterDays) {
    if (!beforeDayIds.has(day.id)) {
      const itemCount = (day.items || []).length;
      notifications.push({
        title: "신혼여행 Day가 추가되었어요",
        body: day.date
          ? `${day.date}${itemCount > 0 ? ` · ${itemCount}개 일정` : ""}`
          : `새 Day`,
        tag: `hm_day_add_${day.id}`,
      });
    }
  }

  return notifications;
}

/** key(catId__itemId)로 항목 이름을 찾는다. 커스텀 항목도 고려. */
function resolveItemName(k, data) {
  const [, itemId] = k.split("__");
  // 커스텀 항목은 custom[catId] 배열에 있음
  const custom = data.custom || {};
  for (const items of Object.values(custom)) {
    const found = (items || []).find((i) => i.id === itemId);
    if (found) return found.text;
  }
  // 기본 항목은 Functions 환경에 defaultData가 없으므로 key를 그대로 반환
  return k;
}

/** lastUpdate에서 해당 key를 변경한 사람을 추출한다. */
function resolveActorByKey(k, data) {
  const info = (data.lastUpdate || {})[k];
  return (info && info.by) || "상대방";
}

// ── Cloud Function 본체 ────────────────────────────────────────

exports.onWeddingUpdated = onDocumentUpdated(
  "weddings/{coupleCode}",
  async (event) => {
    const coupleCode = event.params.coupleCode;
    console.log(`[${coupleCode}] onWeddingUpdated 트리거됨`);

    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after) return null;

    const fcmTokens = after.fcmTokens || [];
    console.log(`[${coupleCode}] fcmTokens 개수: ${fcmTokens.length}`);
    if (fcmTokens.length === 0) {
      console.log(`[${coupleCode}] fcmTokens 없음 — 알림 스킵`);
      return null;
    }

    // 이번 변경을 일으킨 사람 판단:
    // lastUpdate 중 가장 최신 항목의 by를 actor로 사용
    const afterLastUpdate = after.lastUpdate || {};
    let actor = null;
    let latestAt = "";
    for (const info of Object.values(afterLastUpdate)) {
      if (info && info.at && info.at > latestAt) {
        latestAt = info.at;
        actor = info.by;
      }
    }

    // lastUpdate 변화가 없으면 가계부/신혼여행 변경 → 최신 가계부 항목의 by를 참고
    if (!actor) {
      const afterEntries = (after.budget && after.budget.entries) || [];
      const beforeEntries = (before.budget && before.budget.entries) || [];
      const beforeIds = new Set(beforeEntries.map((e) => e.id));
      const newEntry = afterEntries.find((e) => !beforeIds.has(e.id));
      if (newEntry) actor = newEntry.by;
    }
    console.log(`[${coupleCode}] 변경자(actor): ${actor || "알수없음"}`);

    const notifications = buildNotifications(before, after);
    if (notifications.length === 0) {
      console.log(`[${coupleCode}] 알림 대상 변경 없음 — 스킵`);
      return null;
    }

    // 대표 알림 하나만 전송 (여러 변경이 동시에 일어나도 알림 폭탄 방지)
    const notif = notifications[0];

    // actor와 다른 사람의 토큰만 추출
    const targetEntries = fcmTokens.filter((t) => t.token && t.name !== actor);
    const excludedEntries = fcmTokens.filter((t) => t.name === actor);
    console.log(
      `[${coupleCode}] 발송 대상: ${targetEntries.map((t) => t.name).join(", ") || "없음"} / 본인 제외: ${
        excludedEntries.map((t) => t.name).join(", ") || "없음"
      }`
    );

    if (targetEntries.length === 0) {
      console.log(`[${coupleCode}] 발송 대상 토큰 없음 — 스킵`);
      return null;
    }

    const messaging = getMessaging();
    const results = await Promise.allSettled(
      targetEntries.map((t) =>
        messaging.send({
          token: t.token,
          notification: {
            title: notif.title,
            body: notif.body,
          },
          data: {
            tag: notif.tag,
            coupleCode,
          },
          webpush: {
            notification: {
              icon: "/icon-192.png",
              badge: "/icon-192.png",
              tag: notif.tag,
            },
            fcmOptions: {
              link: "/",
            },
          },
        })
      )
    );

    results.forEach((r, i) => {
      const name = targetEntries[i].name || "이름없음";
      if (r.status === "fulfilled") {
        console.log(`[${coupleCode}] ${name} 발송 성공 (messageId: ${r.value})`);
      } else {
        console.error(
          `[${coupleCode}] ${name} 발송 실패: ${(r.reason && r.reason.message) || r.reason}`
        );
      }
    });

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    console.log(
      `[${coupleCode}] 알림 전송 결과: ${succeeded}성공 ${failed}실패 / "${notif.title}" — ${notif.body}`
    );

    return null;
  }
);
