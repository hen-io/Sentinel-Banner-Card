
const CARD_VERSION = "0.2.1";
const CARD_TAG = "sentinel-banner-card";

const IMPORTANCE_LEVELS = ["low", "normal", "high", "critical"];
const BUILTIN_CHANNEL_KEYS = ["info", "alert", "event", "reminder", "security", "system", "chat"];
const LOCALE_TAG = { en: "en", no: "nb-NO" };
const MANUAL_SCROLL_BASE_PX_PER_SECOND = 50;
const DRAG_CLICK_SUPPRESS_THRESHOLD_PX = 5;
const TICKER_EDGE_FADE_PX = 24;

function fireDomEvent(node, type, detail) {
  const event = new CustomEvent(type, { bubbles: true, cancelable: false, composed: true, detail });
  node.dispatchEvent(event);
  return event;
}

function handleTapAction(node, hass, actionConfig) {
  const config = actionConfig || { action: "none" };
  switch (config.action) {
    case "navigate":
      if (config.navigation_path) {
        if (config.navigation_replace) {
          history.replaceState(null, "", config.navigation_path);
        } else {
          history.pushState(null, "", config.navigation_path);
        }
        fireDomEvent(window, "location-changed", { replace: Boolean(config.navigation_replace) });
      }
      break;
    case "url":
      if (config.url_path) {
        window.open(config.url_path, config.new_tab === false ? "_self" : "_blank");
      }
      break;
    case "more-info":
      if (config.entity) {
        fireDomEvent(node, "hass-more-info", { entityId: config.entity });
      }
      break;
    case "toggle":
      if (config.entity && hass) {
        hass.callService("homeassistant", "toggle", {}, { entity_id: config.entity });
      }
      break;
    case "call-service":
    case "perform-action": {
      const serviceStr = config.perform_action || config.service;
      if (serviceStr && hass) {
        const [domain, service] = serviceStr.split(".");
        hass.callService(domain, service, config.data || config.service_data || {}, config.target);
      }
      break;
    }
    default:
      break;
  }
}

const STRINGS = {
  en: { yesterday: "Yesterday" },
  no: { yesterday: "I går" },
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function importanceRank(level) {
  const idx = IMPORTANCE_LEVELS.indexOf(level);
  return idx === -1 ? IMPORTANCE_LEVELS.indexOf("normal") : idx;
}

function fontStyleToCss(value) {
  switch (value) {
    case "bold":
      return { weight: "bold", style: "normal" };
    case "italic":
      return { weight: "normal", style: "italic" };
    case "bold_italic":
      return { weight: "bold", style: "italic" };
    default:
      return { weight: "normal", style: "normal" };
  }
}

const CHANNEL_IMPORTANCE_PREFIX = "channel_importance__";
const CHANNEL_LABELS_PREFIX = "channel_labels__";

function prefixedConfigMap(cfg, prefix) {
  const map = {};
  for (const [key, value] of Object.entries(cfg || {})) {
    if (key.startsWith(prefix) && value && (!Array.isArray(value) || value.length)) {
      map[key.slice(prefix.length).toLowerCase()] = value;
    }
  }
  return map;
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function recordChannelKeys(record) {
  const channels = Array.isArray(record.channels) && record.channels.length ? record.channels : [record.channel];
  return channels.map(lower);
}

function recordLabelKeys(record) {
  return (Array.isArray(record.labels) ? record.labels : []).map(lower);
}

function matchesFilter(record, filter) {
  if (record.show_in_history === false) return false;
  const selected = (filter.channels || []).map(lower);
  const recordChannels = recordChannelKeys(record);
  const inList = selected.some((c) => recordChannels.includes(c));
  if (filter.mode === "exclude" ? inList : selected.length && !inList) return false;

  const rank = importanceRank(record.importance);
  if (filter.mode !== "exclude" && selected.length) {
    const labels = recordLabelKeys(record);
    return recordChannels
      .filter((c) => selected.includes(c))
      .some((c) => {
        const threshold = filter.channelImportance?.[c] || filter.minImportance || "low";
        const wanted = (filter.channelLabels?.[c] || []).map(lower);
        return rank >= importanceRank(threshold) && (!wanted.length || wanted.some((l) => labels.includes(l)));
      });
  }
  return rank >= importanceRank(filter.minImportance || "low");
}

const WS_PREFIXES = ["sentinel", "k93_ans"];
let wsPrefix = null;

class SentinelApi {
  constructor() {
    this.hass = null;
  }

  get legacy() {
    return wsPrefix !== null && wsPrefix !== WS_PREFIXES[0];
  }

  async _withPrefix(fn) {
    if (wsPrefix) return fn(wsPrefix);
    let lastError;
    for (const prefix of WS_PREFIXES) {
      try {
        const result = await fn(prefix);
        wsPrefix = prefix;
        return result;
      } catch (err) {
        if (err?.code !== "unknown_command") throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  call(name, params = {}) {
    return this._withPrefix((prefix) => this.hass.callWS({ ...params, type: `${prefix}/${name}` }));
  }

  subscribe(name, onEvent, params = {}) {
    return this._withPrefix((prefix) =>
      this.hass.connection.subscribeMessage(onEvent, { ...params, type: `${prefix}/${name}` })
    );
  }

  async config() {
    if (!this.legacy) {
      try {
        return await this.call("config");
      } catch (err) {
        if (err?.code !== "unknown_command") throw err;
      }
    }
    const sensor = Object.values(this.hass.states).find((s) => Array.isArray(s.attributes?.channels));
    return { channels: sensor ? sensor.attributes.channels : [] };
  }
}

function channelDefs(config) {
  return Array.isArray(config?.channels) ? config.channels : [];
}

function channelColor(config, record) {
  const key = lower(record.channel);
  return channelDefs(config).find((c) => lower(c.key) === key)?.color || "";
}

function labelName(config, key) {
  for (const channel of channelDefs(config)) {
    const label = (channel.labels || []).find((l) => lower(l.key) === lower(key));
    if (label) return label.name;
  }
  return key;
}

function channelOptions(config) {
  const channels = channelDefs(config);
  if (!channels.length) return BUILTIN_CHANNEL_KEYS.map((key) => ({ value: key, label: key }));
  return channels.map((c) => ({
    value: c.key,
    label: c.enabled === false ? `${c.name} (${c.key}, disabled)` : `${c.name} (${c.key})`,
  }));
}

function labelOptions(config, channelKey) {
  const channel = channelDefs(config).find((c) => lower(c.key) === lower(channelKey));
  return (channel?.labels || []).map((l) => ({ value: l.key, label: l.name }));
}

function defineElement(tag, ctor) {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

const _timeFormatters = new Map();
const _weekdayFormatters = new Map();
function timeFormatter(locale) {
  const key = locale || "";
  let f = _timeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    _timeFormatters.set(key, f);
  }
  return f;
}
function weekdayFormatter(locale) {
  const key = locale || "";
  let f = _weekdayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { weekday: "long" });
    _weekdayFormatters.set(key, f);
  }
  return f;
}

function formatRelativeTime(iso, locale, lang) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const strings = STRINGS[lang] || STRINGS.en;
  const time = timeFormatter(locale).format(date);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

  if (diffDays === 0) return time;
  if (diffDays === 1) return `${strings.yesterday} ${time}`;
  const weekday = weekdayFormatter(locale).format(date);
  const capitalizedWeekday = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${capitalizedWeekday} ${time}`;
}

class SentinelBannerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._api = new SentinelApi();
    this._sentinelConfig = null;
    this._onReconnect = () => this._fetchList();
    this._notifications = [];
    this._subscribed = false;
    this._unsubscribe = null;
    this._manualOffsetPx = 0;
    this._manualTrackEl = null;
    this._manualGroupWidth = 0;
    this._manualScrollPausedUntil = 0;
    this._scrollRafId = null;
    this._lastScrollFrameTime = null;
    this._dragState = null;
    this._dragMoved = false;
    this._manualScrollWasPaused = true;
    this._manualScrollResumedAt = null;
    this._manualEdgeInsetPx = TICKER_EDGE_FADE_PX;
    this._autoScrollTick = this._autoScrollTick.bind(this);
  }

  setConfig(config) {
    this._config = {
      title_icon: null,
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      unacknowledged_effects: true,
      unacknowledged_icon: null,
      unacknowledged_icon_color: null,
      unacknowledged_pulse_color: null,
      unacknowledged_pulse_effect: "radar",
      unacknowledged_pulse_size: 1.8,
      unacknowledged_pulse_speed: 2,
      unacknowledged_badge_color: null,
      unacknowledged_badge_text_color: null,
      language: "auto",
      channels: [],
      channels_mode: "include",
      min_importance: "low",
      ticker_limit: 10,
      ticker_font_size: 1,
      ticker_text_color: null,
      ticker_font_family: null,
      ticker_font_style: "regular",
      ticker_icon_size: 1,
      ticker_manual_scroll: false,
      ticker_manual_scroll_pause: 10,
      ticker_manual_scroll_start_delay: 3,
      ticker_manual_scroll_ramp: 2,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
      tap_action: { action: "none" },
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._api.hass = hass;
    if (!this._subscribed) {
      this._subscribed = true;
      hass.connection.addEventListener("ready", this._onReconnect);
      this._subscribe();
      this._fetchList();
      this._render();
    }
  }

  _lang() {
    const configured = this._config?.language;
    if (configured && configured !== "auto") return configured;
    const hassLang = this._hass?.language || "";
    return /^n[bno]/i.test(hassLang) ? "no" : "en";
  }

  getCardSize() {
    const cfg = this._config;
    if (cfg?.card_height) return Math.max(1, Math.round(cfg.card_height / 50));
    return 1;
  }

  getGridOptions() {
    const cfg = this._config;
    if (!cfg?.card_height) return undefined;
    const rows = Math.max(1, Math.round((Number(cfg.card_height) + 8) / 64));
    return { rows };
  }

  connectedCallback() {
    if (!this._clockInterval) {
      this._clockInterval = setInterval(() => this._refreshRelativeTimestamps(), 30000);
    }
    if (!this._scrollRafId) {
      this._lastScrollFrameTime = null;
      this._manualScrollPausedUntil = Date.now() + this._manualScrollStartDelayMs();
      this._manualScrollWasPaused = true;
      this._manualScrollResumedAt = null;
      this._scrollRafId = requestAnimationFrame(this._autoScrollTick);
    }
  }

  disconnectedCallback() {
    this._hass?.connection.removeEventListener("ready", this._onReconnect);
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._subscribed = false;
    if (this._clockInterval) {
      clearInterval(this._clockInterval);
      this._clockInterval = null;
    }
    if (this._scrollRafId) {
      cancelAnimationFrame(this._scrollRafId);
      this._scrollRafId = null;
    }
  }

  _manualScrollTrack() {
    if (!this._config?.ticker_manual_scroll) return null;
    const track = this._manualTrackEl;
    if (!track || !(this._manualGroupWidth > 0)) return null;
    return { track, groupWidth: this._manualGroupWidth };
  }

  _applyManualOffset(track, extraInsetPx = 0) {
    track.style.transform = `translateX(${extraInsetPx - this._manualOffsetPx}px)`;
  }

  _autoScrollTick(time) {
    this._scrollRafId = requestAnimationFrame(this._autoScrollTick);

    const found = this._manualScrollTrack();
    if (!found) {
      this._lastScrollFrameTime = null;
      return;
    }
    const { track, groupWidth } = found;

    const dt = this._lastScrollFrameTime == null ? 0 : (time - this._lastScrollFrameTime) / 1000;
    this._lastScrollFrameTime = time;

    const isPaused = Boolean(this._dragState) || Date.now() < this._manualScrollPausedUntil;
    if (!isPaused && this._manualScrollWasPaused) this._manualScrollResumedAt = Date.now();
    this._manualScrollWasPaused = isPaused;

    const rampMs = this._manualScrollRampMs();
    const rampMultiplier = isPaused
      ? 0
      : (rampMs > 0 && this._manualScrollResumedAt != null)
        ? Math.min(1, (Date.now() - this._manualScrollResumedAt) / rampMs)
        : 1;

    if (!isPaused && dt > 0) {
      const speed = Number(this._config?.ticker_speed) || 1;
      this._manualOffsetPx += MANUAL_SCROLL_BASE_PX_PER_SECOND * speed * rampMultiplier * dt;
    }

    if (this._manualOffsetPx >= groupWidth) this._manualOffsetPx -= groupWidth;
    else if (this._manualOffsetPx < 0) this._manualOffsetPx += groupWidth;

    if (!this._dragState) {
      const positionFactor = Math.max(0, 1 - this._manualOffsetPx / TICKER_EDGE_FADE_PX);
      const activityFactor = isPaused ? 1 : Math.max(0, 1 - rampMultiplier);
      this._manualEdgeInsetPx = TICKER_EDGE_FADE_PX * positionFactor * activityFactor;
      this._applyManualOffset(track, this._manualEdgeInsetPx);
    }
  }

  _manualScrollPauseMs() {
    const configured = Number(this._config?.ticker_manual_scroll_pause);
    return (Number.isFinite(configured) ? Math.max(0, configured) : 10) * 1000;
  }

  _manualScrollStartDelayMs() {
    const configured = Number(this._config?.ticker_manual_scroll_start_delay);
    return (Number.isFinite(configured) ? Math.max(0, configured) : 3) * 1000;
  }

  _manualScrollRampMs() {
    const configured = Number(this._config?.ticker_manual_scroll_ramp);
    return (Number.isFinite(configured) ? Math.max(0, configured) : 2) * 1000;
  }

  _setupManualScrollDrag() {
    const markInteraction = () => {
      this._manualScrollPausedUntil = Date.now() + this._manualScrollPauseMs();
    };
    this._tickerHostEl.addEventListener("wheel", (ev) => {
      if (ev.target.closest(".ticker-viewport.manual-scroll")) markInteraction();
    }, { passive: true });
    this._tickerHostEl.addEventListener("pointerdown", (ev) => {
      const viewport = ev.target.closest(".ticker-viewport.manual-scroll");
      const found = this._manualScrollTrack();
      if (!viewport || !found) return;
      ev.preventDefault();
      markInteraction();
      this._dragState = { viewport, startX: ev.clientX, startOffset: this._manualOffsetPx, pointerId: ev.pointerId };
      this._dragMoved = false;
      viewport.classList.add("dragging");
      viewport.setPointerCapture(ev.pointerId);
    });
    this._tickerHostEl.addEventListener("pointermove", (ev) => {
      const drag = this._dragState;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const found = this._manualScrollTrack();
      if (!found) return;
      if (Math.abs(ev.clientX - drag.startX) > DRAG_CLICK_SUPPRESS_THRESHOLD_PX) this._dragMoved = true;
      const raw = drag.startOffset - (ev.clientX - drag.startX);
      this._manualOffsetPx = ((raw % found.groupWidth) + found.groupWidth) % found.groupWidth;
      this._applyManualOffset(found.track);
      markInteraction();
    });
    const endDrag = (ev) => {
      const drag = this._dragState;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      drag.viewport.classList.remove("dragging");
      drag.viewport.releasePointerCapture(ev.pointerId);
      this._dragState = null;
    };
    this._tickerHostEl.addEventListener("pointerup", endDrag);
    this._tickerHostEl.addEventListener("pointercancel", endDrag);
  }

  async _subscribe() {
    try {
      this._unsubscribe = await this._api.subscribe("subscribe", (msg) => {
        if (msg.notification) this._onUpdate(msg.notification);
        if (msg.deleted_ids) this._onDelete(msg.deleted_ids);
        if (msg.config) {
          this._sentinelConfig = msg.config;
          this._lastTickerHtml = null;
          this._render();
        }
      });
    } catch (err) {
      console.error(`${CARD_TAG}: failed to subscribe`, err);
    }
  }

  async _fetchList() {
    try {
      const cfg = this._config || {};
      const limit = cfg.max_items ?? 50;
      const filtered = Boolean(cfg.channels?.length || (cfg.min_importance && cfg.min_importance !== "low"));
      const results = [await this._api.call("list", { include_acknowledged: true, limit })];
      const more = [this._api.config()];
      if (filtered) {
        more.push(
          this._api.call("list", {
            include_acknowledged: true,
            limit,
            channels: cfg.channels?.length ? cfg.channels : undefined,
            channel_mode: cfg.channels_mode || "include",
            min_importance: cfg.min_importance || undefined,
          })
        );
      }
      if (!this._api.legacy) more.push(this._api.call("list", { outstanding_only: true }));
      const [config, ...lists] = await Promise.all(more);
      this._sentinelConfig = config;
      const merged = new Map();
      for (const result of [...results, ...lists]) {
        for (const record of result.notifications) merged.set(record.id, record);
      }
      this._notifications = [...merged.values()].sort((a, b) => (a.created < b.created ? 1 : -1));
      this._lastTickerHtml = null;
      this._render();
    } catch (err) {
      console.error(`${CARD_TAG}: failed to load notifications`, err);
    }
  }

  _onUpdate(record) {
    const idx = this._notifications.findIndex((n) => n.id === record.id);
    if (idx >= 0) {
      this._notifications = [
        ...this._notifications.slice(0, idx),
        record,
        ...this._notifications.slice(idx + 1),
      ];
    } else {
      this._notifications = [record, ...this._notifications];
    }
    this._render();
  }

  _onDelete(deletedIds) {
    const idSet = new Set(deletedIds);
    this._notifications = this._notifications.filter((n) => !idSet.has(n.id));
    this._render();
  }

  _titleIconHtml(hasUnacknowledged, unacknowledgedCount) {
    const cfg = this._config;
    const icon = (hasUnacknowledged && cfg.unacknowledged_icon) || cfg.title_icon;
    const pulseColor = hasUnacknowledged ? cfg.unacknowledged_pulse_color : "";
    const showCountBadge = Boolean(cfg.unacknowledged_badge_color) && unacknowledgedCount > 0;
    if (!icon && !pulseColor && !showCountBadge) return "";
    const size = Number(cfg.title_icon_size) || 24;
    const color = (hasUnacknowledged && cfg.unacknowledged_icon_color) || cfg.title_icon_color || "var(--primary-text-color)";
    const background = cfg.title_icon_background || "transparent";
    const pulseEffect = ["radar", "ring", "glow", "flash", "outline", "shake"].includes(
      cfg.unacknowledged_pulse_effect
    )
      ? cfg.unacknowledged_pulse_effect
      : "radar";
    const pulseClass = pulseColor ? ` pulsing effect-${pulseEffect}` : "";
    const pulseSize = Math.max(1.1, Number(cfg.unacknowledged_pulse_size) || 1.8);
    const pulseSpeed = Math.max(0.3, Number(cfg.unacknowledged_pulse_speed) || 2);
    const pulseStyle = pulseColor
      ? ` --sentinel-pulse-color: ${esc(pulseColor)}; --sentinel-pulse-scale: ${pulseSize};` +
        ` --sentinel-pulse-duration: ${pulseSpeed}s; --sentinel-icon-bg: ${esc(background)};`
      : "";
    const iconHtml = icon
      ? `<ha-icon icon="${esc(icon)}" style="color: ${esc(color)}; --mdc-icon-size: ${Math.round(size * 0.6)}px;"></ha-icon>`
      : "";
    const badgeSize = Math.max(14, Math.min(22, Math.round(size * 0.5)));
    const badgeFontSize = Math.max(9, Math.round(badgeSize * 0.62));
    const badgeTextColor = cfg.unacknowledged_badge_text_color || "#ffffff";
    const badgeText = unacknowledgedCount > 9 ? "9+" : String(unacknowledgedCount);
    const badgeHtml = showCountBadge
      ? `<span class="count-badge" style="min-width: ${badgeSize}px; height: ${badgeSize}px; font-size: ${badgeFontSize}px; line-height: ${badgeSize}px; background: ${esc(cfg.unacknowledged_badge_color)}; color: ${esc(badgeTextColor)};">${badgeText}</span>`
      : "";
    return `
      <span class="title-icon${pulseClass}" style="width: ${size}px; height: ${size}px; background: ${esc(background)};${pulseStyle}">
        ${iconHtml}
        ${badgeHtml}
      </span>
    `;
  }

  _tickerItemHtml(record, locale, lang) {
    const icon = record.icon || "mdi:bell-outline";
    const color = channelColor(this._sentinelConfig, record);
    const iconHtml = icon.startsWith("mdi:")
      ? `<ha-icon class="ticker-icon" icon="${esc(icon)}"${color ? ` style="color: ${esc(color)};"` : ""}></ha-icon>`
      : `<img class="ticker-icon-img" src="${esc(icon)}" alt="" />`;
    return (
      `<span class="ticker-item">${iconHtml}` +
      `<span class="ticker-text">` +
      `<span class="ticker-time" data-created="${esc(record.created)}">${esc(formatRelativeTime(record.created, locale, lang))}</span>` +
      ` : ${esc(record.message)}</span></span>`
    );
  }

  _refreshRelativeTimestamps() {
    if (!this._tickerHostEl) return;
    const timeEls = this._tickerHostEl.querySelectorAll(".ticker-time[data-created]");
    if (!timeEls.length) return;
    const lang = this._lang();
    const locale = LOCALE_TAG[lang] || undefined;
    for (const el of timeEls) {
      const label = formatRelativeTime(el.dataset.created, locale, lang);
      if (el.textContent !== label) el.textContent = label;
    }
  }

  _renderTicker(locale, lang) {
    const cfg = this._config;
    const all = this._notifications || [];
    const unacknowledged = all.filter((n) => n.requires_ack && !n.acknowledged && n.show_in_history !== false);
    const effectsEnabled = cfg.unacknowledged_effects !== false;
    const hasUnacknowledged = effectsEnabled && unacknowledged.length > 0;
    const iconHtml = this._titleIconHtml(hasUnacknowledged, effectsEnabled ? unacknowledged.length : 0);
    const filter = {
      channels: cfg.channels,
      mode: cfg.channels_mode,
      minImportance: cfg.min_importance,
      channelImportance: prefixedConfigMap(cfg, CHANNEL_IMPORTANCE_PREFIX),
      channelLabels: prefixedConfigMap(cfg, CHANNEL_LABELS_PREFIX),
    };
    const items = all
      .filter((n) => matchesFilter(n, filter))
      .slice(0, cfg.ticker_limit ?? 10);

    if (!items.length) {
      return iconHtml ? `<div class="ticker-wrap">${iconHtml}</div>` : "";
    }

    const sep = `<span class="ticker-sep">&bull;</span>`;
    const group = items.map((n) => this._tickerItemHtml(n, locale, lang)).join(sep) + sep;
    const speed = Number(cfg.ticker_speed) || 1;
    const baseLoopSeconds = Math.min(items.length * 5, 120);
    const duration = Math.max(4, baseLoopSeconds / speed);
    const fontSize = Number(cfg.ticker_font_size) || 1;
    const iconScale = Number(cfg.ticker_icon_size) || 1;
    const { weight: fontWeight, style: fontStyle } = fontStyleToCss(cfg.ticker_font_style);
    const trackStyle =
      `animation-duration: ${duration}s; font-size: ${fontSize}em;` +
      ` --sentinel-ticker-icon-scale: ${iconScale};` +
      ` --sentinel-ticker-font-weight: ${fontWeight}; --sentinel-ticker-font-style: ${fontStyle};` +
      (cfg.ticker_text_color ? ` --sentinel-ticker-text-color: ${esc(cfg.ticker_text_color)};` : "") +
      (cfg.ticker_font_family ? ` --sentinel-ticker-font-family: ${esc(cfg.ticker_font_family)};` : "");
    const manualScroll = Boolean(cfg.ticker_manual_scroll);

    return `
      <div class="ticker-wrap">
        ${iconHtml}
        <div class="ticker-viewport${manualScroll ? " manual-scroll" : ""}">
          <div class="ticker-track${manualScroll ? "" : " auto-scroll"}" style="${trackStyle}">
            ${group}${group}
          </div>
        </div>
      </div>
    `;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;

    const cfg = this._config;
    const lang = this._lang();
    const locale = LOCALE_TAG[lang] || undefined;
    const tickerHtml = this._renderTicker(locale, lang);

    const cardThemeStyles = [];
    if (cfg.card_height) cardThemeStyles.push(`height: ${Number(cfg.card_height)}px`);
    if (cfg.card_background_color) cardThemeStyles.push(`background: ${cfg.card_background_color}`);
    if (cfg.card_border_radius != null && cfg.card_border_radius !== "") {
      cardThemeStyles.push(`border-radius: ${Number(cfg.card_border_radius)}px`);
    }
    if (cfg.card_border_color || (cfg.card_border_width != null && cfg.card_border_width !== "")) {
      cardThemeStyles.push(`border-style: solid`);
      if (cfg.card_border_color) cardThemeStyles.push(`border-color: ${cfg.card_border_color}`);
      if (cfg.card_border_width != null && cfg.card_border_width !== "") {
        cardThemeStyles.push(`border-width: ${Number(cfg.card_border_width)}px`);
      }
    }

    if (!this._built) {
      this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          display: flex;
          align-items: center;
          overflow: hidden;
        }
        ha-card.tappable { cursor: pointer; }
        .title-icon {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .title-icon ha-icon {
          position: relative;
          z-index: 1;
        }
        .title-icon .count-badge {
          position: absolute;
          top: -4px;
          right: -4px;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0 3px;
          border-radius: 999px;
          font-weight: bold;
          z-index: 2;
        }
        .title-icon.pulsing.effect-radar::before,
        .title-icon.pulsing.effect-radar::after,
        .title-icon.pulsing.effect-ring::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 999px;
          background: var(--sentinel-pulse-color);
          animation: sentinel-radar-ping var(--sentinel-pulse-duration, 2s) linear infinite;
          animation-fill-mode: backwards;
          will-change: transform, opacity;
        }
        .title-icon.pulsing.effect-radar::after {
          animation-delay: calc(var(--sentinel-pulse-duration, 2s) / 2);
        }
        @keyframes sentinel-radar-ping {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(var(--sentinel-pulse-scale, 1.8)); opacity: 0; }
        }
        .title-icon.pulsing.effect-glow::before {
          content: "";
          position: absolute;
          inset: -6px;
          border-radius: 999px;
          background: var(--sentinel-pulse-color);
          filter: blur(6px);
          animation: sentinel-glow-pulse var(--sentinel-pulse-duration, 2s) ease-in-out infinite;
        }
        @keyframes sentinel-glow-pulse {
          0%, 100% { opacity: 0.25; }
          50% { opacity: 0.75; }
        }
        .title-icon.pulsing.effect-flash {
          animation: sentinel-flash-pulse var(--sentinel-pulse-duration, 2s) ease-in-out infinite;
        }
        @keyframes sentinel-flash-pulse {
          0%, 100% { background: var(--sentinel-icon-bg, transparent); }
          50% { background: var(--sentinel-pulse-color); }
        }
        .title-icon.pulsing.effect-outline::before {
          content: "";
          position: absolute;
          inset: -3px;
          border-radius: 999px;
          border: 2px solid var(--sentinel-pulse-color);
          animation: sentinel-outline-pulse var(--sentinel-pulse-duration, 2s) ease-in-out infinite;
        }
        @keyframes sentinel-outline-pulse {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 1; }
        }
        .title-icon.pulsing.effect-shake {
          animation: sentinel-shake var(--sentinel-pulse-duration, 2s) ease-in-out infinite;
        }
        @keyframes sentinel-shake {
          0%, 100% { transform: rotate(0deg); }
          10% { transform: rotate(-12deg); }
          20% { transform: rotate(10deg); }
          30% { transform: rotate(-8deg); }
          40% { transform: rotate(6deg); }
          50% { transform: rotate(-3deg); }
          60%, 100% { transform: rotate(0deg); }
        }
        .ticker-wrap {
          display: flex;
          align-items: center;
          gap: 5px;
          width: 100%;
          padding: 6px 12px;
          box-sizing: border-box;
        }
        .ticker-viewport {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          -webkit-mask-image: linear-gradient(to right, transparent 0, black ${TICKER_EDGE_FADE_PX}px, black calc(100% - ${TICKER_EDGE_FADE_PX}px), transparent 100%);
          mask-image: linear-gradient(to right, transparent 0, black ${TICKER_EDGE_FADE_PX}px, black calc(100% - ${TICKER_EDGE_FADE_PX}px), transparent 100%);
        }
        .ticker-viewport.manual-scroll {
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          cursor: grab;
        }
        .ticker-viewport.manual-scroll.dragging { cursor: grabbing; }
        .ticker-track {
          display: inline-block;
          white-space: nowrap;
          color: var(--sentinel-ticker-text-color, var(--primary-text-color));
          font-family: var(--sentinel-ticker-font-family, inherit);
          font-weight: var(--sentinel-ticker-font-weight, normal);
          font-style: var(--sentinel-ticker-font-style, normal);
          line-height: 1.4;
          will-change: transform;
        }
        .ticker-track.auto-scroll {
          animation-name: sentinel-ticker;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        .ticker-item {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          line-height: 1;
          vertical-align: middle;
        }
        .ticker-text {
          display: inline-flex;
          align-items: center;
          line-height: 1;
        }
        .ticker-icon {
          --mdc-icon-size: calc(1em * var(--sentinel-ticker-icon-scale, 1));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: calc(1em * var(--sentinel-ticker-icon-scale, 1));
          height: calc(1em * var(--sentinel-ticker-icon-scale, 1));
          color: var(--sentinel-ticker-text-color, var(--primary-text-color));
          flex-shrink: 0;
        }
        .ticker-icon-img {
          display: inline-block;
          width: calc(1em * var(--sentinel-ticker-icon-scale, 1));
          height: calc(1em * var(--sentinel-ticker-icon-scale, 1));
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          vertical-align: middle;
        }
        .ticker-sep {
          display: inline-flex;
          align-items: center;
          margin: 0 12px;
          opacity: 0.5;
        }
        @keyframes sentinel-ticker {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
      </style>
      <ha-card>
        <div class="ticker-host"></div>
      </ha-card>
      `;
      this._built = true;
      this._cardEl = this.shadowRoot.querySelector("ha-card");
      this._tickerHostEl = this.shadowRoot.querySelector(".ticker-host");
      this._cardEl.addEventListener("click", () => {
        if (this._dragMoved) {
          this._dragMoved = false;
          return;
        }
        if (this._config?.tap_action?.action) {
          handleTapAction(this, this._hass, this._config.tap_action);
        }
      });
      this._setupManualScrollDrag();
    }

    if (cardThemeStyles.length) {
      this._cardEl.setAttribute("style", cardThemeStyles.join("; "));
    } else {
      this._cardEl.removeAttribute("style");
    }

    const hasTapAction = Boolean(cfg.tap_action && cfg.tap_action.action && cfg.tap_action.action !== "none");
    this._cardEl.classList.toggle("tappable", hasTapAction);

    if (tickerHtml !== this._lastTickerHtml) {
      this._lastTickerHtml = tickerHtml;
      this._tickerHostEl.innerHTML = tickerHtml;
      if (cfg.ticker_manual_scroll) {
        const track = this._tickerHostEl.querySelector(".ticker-track");
        this._manualTrackEl = track;
        this._manualGroupWidth = track ? track.scrollWidth / 2 : 0;
        const found = this._manualScrollTrack();
        if (found) this._applyManualOffset(found.track, this._manualEdgeInsetPx);
      } else {
        this._manualTrackEl = null;
      }
    }
  }

  static getStubConfig() {
    return {
      title_icon: "mdi:bell-outline",
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      unacknowledged_effects: true,
      unacknowledged_icon: null,
      unacknowledged_icon_color: null,
      unacknowledged_pulse_color: null,
      unacknowledged_pulse_effect: "radar",
      unacknowledged_pulse_size: 1.8,
      unacknowledged_pulse_speed: 2,
      unacknowledged_badge_color: null,
      unacknowledged_badge_text_color: null,
      language: "auto",
      channels: [],
      channels_mode: "include",
      min_importance: "low",
      ticker_limit: 10,
      ticker_font_size: 1,
      ticker_text_color: null,
      ticker_font_family: null,
      ticker_font_style: "regular",
      ticker_icon_size: 1,
      ticker_manual_scroll: false,
      ticker_manual_scroll_pause: 10,
      ticker_manual_scroll_start_delay: 3,
      ticker_manual_scroll_ramp: 2,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
      tap_action: { action: "none" },
    };
  }

  static getConfigElement() {
    return document.createElement(`${CARD_TAG}-editor`);
  }
}

class SentinelBannerCardEditor extends HTMLElement {
  constructor() {
    super();
    this._api = new SentinelApi();
    this._sentinelConfig = null;
  }

  setConfig(config) {
    this._config = config;
    this._updateForm();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._api.hass = hass;
    if (first) this._loadConfig();
    this._updateForm();
  }

  async _loadConfig() {
    try {
      this._sentinelConfig = await this._api.config();
      this._updateForm();
    } catch (err) {
      console.error(`${CARD_TAG}-editor: failed to load channels`, err);
    }
  }

  connectedCallback() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (item) => this._label(item.name);
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })
        );
      });
      this.appendChild(this._form);

      const versionEl = document.createElement("div");
      versionEl.textContent = `Sentinel Banner Card v${CARD_VERSION}`;
      versionEl.style.cssText = "text-align: right; font-size: 0.75em; opacity: 0.5; padding: 4px 2px 0;";
      this.appendChild(versionEl);
    }
    this._updateForm();
  }

  _label(name) {
    for (const [prefix, suffix] of [
      [CHANNEL_IMPORTANCE_PREFIX, "minimum importance"],
      [CHANNEL_LABELS_PREFIX, "labels (empty = all)"],
    ]) {
      if (name.startsWith(prefix)) {
        const key = name.slice(prefix.length);
        const option = channelOptions(this._sentinelConfig).find((o) => o.value === key);
        return `${option ? option.label : key}: ${suffix}`;
      }
    }
    return SentinelBannerCardEditor.LABELS[name] || name;
  }

  _channelOptions() {
    return channelOptions(this._sentinelConfig);
  }

  _schema() {
    const importanceOptions = IMPORTANCE_LEVELS.map((value) => ({
      value,
      label: value[0].toUpperCase() + value.slice(1),
    }));
    const channelSelector = {
      select: { multiple: true, custom_value: true, options: this._channelOptions() },
    };
    const channelModeSelector = {
      select: {
        options: [
          { value: "include", label: "Show only selected channels" },
          { value: "exclude", label: "Hide selected channels" },
        ],
      },
    };
    const languageSelector = {
      select: {
        options: [
          { value: "auto", label: "Automatic (match Home Assistant)" },
          { value: "en", label: "English" },
          { value: "no", label: "Norsk" },
        ],
      },
    };

    const perChannelImportanceSelector = {
      select: { options: [{ value: "", label: "(use global default)" }, ...importanceOptions] },
    };
    const selectedChannels = (this._config?.channels_mode || "include") !== "exclude"
      ? (this._config?.channels || [])
      : [];
    const perChannelImportanceFields = selectedChannels.flatMap((channelKey) => {
      const fields = [{ name: `${CHANNEL_IMPORTANCE_PREFIX}${channelKey}`, selector: perChannelImportanceSelector }];
      const labels = labelOptions(this._sentinelConfig, channelKey);
      if (labels.length) {
        fields.push({
          name: `${CHANNEL_LABELS_PREFIX}${channelKey}`,
          selector: { select: { options: labels, multiple: true, custom_value: true } },
        });
      }
      return fields;
    });

    return [
      {
        name: "group_title_icon",
        type: "expandable",
        title: "Title icon",
        expanded: true,
        flatten: true,
        schema: [
          { name: "title_icon", selector: { icon: {} } },
          {
            name: "title_icon_size",
            selector: { number: { min: 12, max: 64, step: 1, mode: "box", unit_of_measurement: "px" } },
          },
          { name: "title_icon_color", selector: { text: {} } },
          { name: "title_icon_background", selector: { text: {} } },
        ],
      },
      {
        name: "group_unacknowledged",
        type: "expandable",
        title: "Unacknowledged indicator",
        expanded: true,
        flatten: true,
        schema: [
          { name: "unacknowledged_effects", selector: { boolean: {} } },
          { name: "unacknowledged_icon", selector: { icon: {} } },
          { name: "unacknowledged_icon_color", selector: { text: {} } },
          { name: "unacknowledged_pulse_color", selector: { text: {} } },
          {
            name: "unacknowledged_pulse_effect",
            selector: {
              select: {
                options: [
                  { value: "radar", label: "Radar (two expanding rings)" },
                  { value: "ring", label: "Ring (single expanding ring)" },
                  { value: "glow", label: "Glow (soft breathing glow)" },
                  { value: "flash", label: "Flash (badge flashes to the pulse color)" },
                  { value: "outline", label: "Outline (fixed-size ring, pulses opacity)" },
                  { value: "shake", label: "Shake (badge wiggles side to side)" },
                ],
              },
            },
          },
          {
            name: "unacknowledged_pulse_size",
            selector: { number: { min: 1.1, max: 4, step: 0.1, mode: "box" } },
          },
          {
            name: "unacknowledged_pulse_speed",
            selector: { number: { min: 0.3, max: 6, step: 0.1, mode: "box", unit_of_measurement: "s" } },
          },
          { name: "unacknowledged_badge_color", selector: { text: {} } },
          { name: "unacknowledged_badge_text_color", selector: { text: {} } },
        ],
      },
      {
        name: "group_filtering",
        type: "expandable",
        title: "Notifications & filtering",
        expanded: true,
        flatten: true,
        schema: [
          { name: "language", selector: languageSelector },
          { name: "channels_mode", selector: channelModeSelector },
          { name: "channels", selector: channelSelector },
          { name: "min_importance", selector: { select: { options: importanceOptions } } },
          ...perChannelImportanceFields,
          { name: "max_items", selector: { number: { min: 1, max: 500, mode: "box" } } },
        ],
      },
      {
        name: "group_ticker_text",
        type: "expandable",
        title: "Ticker text",
        expanded: true,
        flatten: true,
        schema: [
          { name: "ticker_limit", selector: { number: { min: 1, max: 500, mode: "box" } } },
          {
            name: "ticker_font_size",
            selector: { number: { min: 0.5, max: 3, step: 0.05, mode: "box" } },
          },
          { name: "ticker_text_color", selector: { text: {} } },
          { name: "ticker_font_family", selector: { text: {} } },
          {
            name: "ticker_font_style",
            selector: {
              select: {
                options: [
                  { value: "regular", label: "Regular" },
                  { value: "bold", label: "Bold" },
                  { value: "italic", label: "Italic" },
                  { value: "bold_italic", label: "Bold italic" },
                ],
              },
            },
          },
          {
            name: "ticker_icon_size",
            selector: { number: { min: 0.5, max: 3, step: 0.05, mode: "box" } },
          },
          {
            name: "ticker_speed",
            selector: { number: { min: 0.25, max: 4, step: 0.25, mode: "box" } },
          },
        ],
      },
      {
        name: "group_manual_scroll",
        type: "expandable",
        title: "Manual scroll",
        expanded: true,
        flatten: true,
        schema: [
          { name: "ticker_manual_scroll", selector: { boolean: {} } },
          {
            name: "ticker_manual_scroll_pause",
            selector: { number: { min: 0, max: 60, step: 1, mode: "box", unit_of_measurement: "s" } },
          },
          {
            name: "ticker_manual_scroll_start_delay",
            selector: { number: { min: 0, max: 30, step: 1, mode: "box", unit_of_measurement: "s" } },
          },
          {
            name: "ticker_manual_scroll_ramp",
            selector: { number: { min: 0, max: 15, step: 0.5, mode: "box", unit_of_measurement: "s" } },
          },
        ],
      },
      {
        name: "group_card_appearance",
        type: "expandable",
        title: "Card appearance",
        expanded: true,
        flatten: true,
        schema: [
          {
            name: "card_height",
            selector: { number: { min: 30, max: 500, step: 5, mode: "box", unit_of_measurement: "px" } },
          },
          { name: "card_background_color", selector: { text: {} } },
          {
            name: "card_border_radius",
            selector: { number: { min: 0, max: 100, step: 1, mode: "box", unit_of_measurement: "px" } },
          },
          { name: "card_border_color", selector: { text: {} } },
          {
            name: "card_border_width",
            selector: { number: { min: 0, max: 20, step: 1, mode: "box", unit_of_measurement: "px" } },
          },
        ],
      },
      { name: "tap_action", selector: { ui_action: {} } },
    ];
  }

  _updateForm() {
    if (!this._form || !this._config) return;
    this._form.hass = this._hass;
    const schema = this._schema();
    const schemaJson = JSON.stringify(schema);
    if (schemaJson !== this._schemaJson) {
      this._schemaJson = schemaJson;
      this._form.schema = schema;
    }
    this._form.data = this._config;
  }
}

SentinelBannerCardEditor.LABELS = {
  group_title_icon: "Title icon",
  group_unacknowledged: "Unacknowledged indicator",
  group_filtering: "Notifications & filtering",
  group_ticker_text: "Ticker text",
  group_manual_scroll: "Manual scroll",
  group_card_appearance: "Card appearance",
  title_icon: "Title icon",
  title_icon_size: "Title icon size (px)",
  title_icon_color: "Title icon color (CSS color, blank = theme text color)",
  title_icon_background: "Title icon backdrop (CSS color, blank = none)",
  unacknowledged_effects: "React to unacknowledged notifications (icon/color/pulse/badge)",
  unacknowledged_icon: "Icon while unacknowledged notifications exist (blank = keep title icon)",
  unacknowledged_icon_color: "Icon color while unacknowledged (CSS color, blank = title icon color)",
  unacknowledged_pulse_color: "Pulsing effect color while unacknowledged (CSS color, blank = no pulse)",
  unacknowledged_pulse_effect: "Pulsing effect style",
  unacknowledged_pulse_size: "Pulsing effect max size (x badge size, radar/ring only)",
  unacknowledged_pulse_speed: "Pulsing effect speed (seconds per cycle)",
  unacknowledged_badge_color: "Unacknowledged count badge color (CSS color, blank = no badge)",
  unacknowledged_badge_text_color: "Unacknowledged count badge text color (CSS color, blank = white)",
  language: "Language",
  channels_mode: "Channel filter mode",
  channels: "Channels (empty = no filter; suggests configured channels)",
  min_importance: "Minimum importance",
  ticker_limit: "Max items in rotation",
  ticker_font_size: "Font size (em)",
  ticker_text_color: "Ticker text color (CSS color, blank = theme text color)",
  ticker_font_family: "Ticker font family (CSS font-family, blank = theme default)",
  ticker_font_style: "Ticker text style",
  ticker_icon_size: "Per-notification icon size (x text size)",
  ticker_manual_scroll: "Allow manual scroll/drag",
  ticker_manual_scroll_pause: "Auto-scroll pause after manual scroll/drag (seconds)",
  ticker_manual_scroll_start_delay: "Pause before auto-scroll starts on card load (seconds)",
  ticker_manual_scroll_ramp: "Time to reach full scroll speed after starting/resuming (seconds)",
  ticker_speed: "Scroll speed (x)",
  max_items: "Max records fetched",
  card_height: "Card height (px, blank = auto-fit to the ticker line)",
  card_background_color: "Card background color override (CSS color, blank = theme default)",
  card_border_radius: "Card corner radius override (px, blank = theme default)",
  card_border_color: "Card border color override (CSS color, blank = theme default)",
  card_border_width: "Card border width override (px, blank = theme default)",
  tap_action: "Tap action",
};

defineElement(CARD_TAG, SentinelBannerCard);
defineElement(`${CARD_TAG}-editor`, SentinelBannerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Sentinel Banner Card",
  description: "A scrolling notification banner for the Sentinel integration, filterable by channel and label.",
});
