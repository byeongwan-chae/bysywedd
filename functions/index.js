const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// ── 알림 메시지 생성 헬퍼 ──────────────────────────────────────

function formatWon(amount) {
  return "₩" + Math.round(amount).toLocaleString("ko-KR");
}

// 항목 이름을 알 수 없을 때(서버에 defaultData가 없는 기본 항목 등) 쓰는 무난한 문구
const UNKNOWN_ITEM_LABEL = "일정이 업데이트됐어요";

/**
 * before/after 데이터를 비교해 알림 페이로드 목록을 반환한다.
 * @param {string} defaultActor 이번 변경을 일으킨 사람(문서 단위로 판단한 대표 actor).
 *   개별 이벤트에 자체 by 정보가 없을 때(가계부 삭제, 신혼여행 일정/Day 추가 등) 이 값을 사용한다.
 * @returns {{ title: string, body: string, tag: string }[]}
 */
function buildNotifications(before, after, defaultActor) {
  const notifications = [];
  const fallbackActor = defaultActor || "상대방";

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
    const itemName = resolveItemName(k, after) || UNKNOWN_ITEM_LABEL;
    const changerName = next.by || fallbackActor;
    notifications.push({
      title: `${changerName}님이 항목을 체크했어요`,
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

    const changerName = (beforeLastUpdate[k] && beforeLastUpdate[k].by) || fallbackActor;
    const itemName = resolveItemName(k, before) || UNKNOWN_ITEM_LABEL;
    notifications.push({
      title: `${changerName}님이 체크를 해제했어요`,
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
    const changerName = resolveActorByKey(k, after) || fallbackActor;
    notifications.push({
      title: itemName
        ? `${changerName}님이 ${itemName}에 메모를 남겼어요`
        : `${changerName}님이 메모를 남겼어요`,
      body: itemName ? next : UNKNOWN_ITEM_LABEL,
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
    const changerName = (added[0] && added[0].by) || fallbackActor;
    const itemName = resolveItemName(k, after);
    const addedCount = nextList.length - prevCount;
    notifications.push({
      title: itemName
        ? `${changerName}님이 ${itemName}에 사진을 추가했어요`
        : `${changerName}님이 사진을 추가했어요`,
      body: itemName ? `+${addedCount}장` : UNKNOWN_ITEM_LABEL,
      tag: `photo_${k}`,
    });
  }

  // ── 4. 가계부 항목 추가 ──────────────────────────────────────
  const beforeEntries = (before.budget && before.budget.entries) || [];
  const afterEntries = (after.budget && after.budget.entries) || [];
  const beforeEntryIds = new Set(beforeEntries.map((e) => e.id));

  for (const entry of afterEntries) {
    if (beforeEntryIds.has(entry.id)) continue;
    const changerName = entry.by || fallbackActor;
    const typeLabel = entry.type === "income" ? "수입" : "지출";
    notifications.push({
      title: `${changerName}님이 가계부에 ${entry.desc}을 추가했어요 (${formatWon(entry.amount)})`,
      body: `${typeLabel}${entry.category ? ` · ${entry.category}` : ""}`,
      tag: `budget_add_${entry.id}`,
    });
  }

  // 가계부 항목 삭제
  const afterEntryIds = new Set(afterEntries.map((e) => e.id));
  for (const entry of beforeEntries) {
    if (afterEntryIds.has(entry.id)) continue;
    notifications.push({
      title: `${fallbackActor}님이 가계부에서 ${entry.desc}을 삭제했어요`,
      body: formatWon(entry.amount),
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
        const time = item.time || "";
        const place = item.place || "";
        const memo = item.memo || "";
        let body = [time, place].filter(Boolean).join(" ");
        if (memo) body = body ? `${body} · ${memo}` : memo;
        notifications.push({
          title: `${fallbackActor}님이 신혼여행 일정을 추가했어요`,
          body: body || UNKNOWN_ITEM_LABEL,
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
        title: `${fallbackActor}님이 Day를 추가했어요`,
        body: day.date
          ? `${day.date}${itemCount > 0 ? ` · ${itemCount}개 일정` : ""}`
          : UNKNOWN_ITEM_LABEL,
        tag: `hm_day_add_${day.id}`,
      });
    }
  }

  return notifications;
}

/**
 * key(catId__itemId)로 항목 이름을 찾는다. 커스텀 항목만 서버에서 알 수 있다.
 * 기본(내장) 체크리스트 항목은 defaultData가 서버에 없어 이름을 알 수 없으므로 null을 반환한다.
 * @returns {string|null}
 */
function resolveItemName(k, data) {
  const [, itemId] = k.split("__");
  const custom = data.custom || {};
  for (const items of Object.values(custom)) {
    const found = (items || []).find((i) => i.id === itemId);
    if (found) return found.text;
  }
  return null;
}

/** lastUpdate에서 해당 key를 변경한 사람을 추출한다. */
function resolveActorByKey(k, data) {
  const info = (data.lastUpdate || {})[k];
  return (info && info.by) || null;
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

    const notifications = buildNotifications(before, after, actor);
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
