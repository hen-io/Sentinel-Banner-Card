
const IMPORTANCE_LEVELS = ["low", "normal", "high", "critical"];
const BUILTIN_CHANNEL_KEYS = ["info", "alert", "event", "reminder", "security", "system"];
const LOCALE_TAG = { en: "en", no: "nb-NO" };

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

function matchesFilter(record, channels, minImportance, channelMode) {
  if (record.show_in_history === false) return false;
  const hasList = Boolean(channels && channels.length);
  const recordChannels = (Array.isArray(record.channels) && record.channels.length
    ? record.channels
    : [record.channel]
  ).map((c) => String(c || "").toLowerCase());
  const inList = hasList && channels.some((c) => recordChannels.includes(String(c).toLowerCase()));
  const channelOk = channelMode === "exclude" ? !inList : !hasList || inList;
  const importanceOk = importanceRank(record.importance) >= importanceRank(minImportance || "low");
  return channelOk && importanceOk;
}

function formatRelativeTime(iso, locale, lang) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const strings = STRINGS[lang] || STRINGS.en;
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

  if (diffDays === 0) return time;
  if (diffDays === 1) return `${strings.yesterday} ${time}`;
  return `${date.toLocaleDateString(locale, { weekday: "long" })} ${time}`;
}

class K93AnsBannerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._notifications = [];
    this._subscribed = false;
    this._unsubscribe = null;
  }

  setConfig(config) {
    this._config = {
      title_icon: null,
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      language: "auto",
      channels: [],
      channels_mode: "include",
      min_importance: "low",
      ticker_limit: 10,
      ticker_font_size: 1,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._subscribed) {
      this._subscribed = true;
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

  connectedCallback() {
    if (!this._clockInterval) {
      this._clockInterval = setInterval(() => this._render(), 30000);
    }
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
      this._subscribed = false;
    }
    if (this._clockInterval) {
      clearInterval(this._clockInterval);
      this._clockInterval = null;
    }
  }

  async _subscribe() {
    try {
      this._unsubscribe = await this._hass.connection.subscribeMessage(
        (msg) => {
          if (msg.notification) this._onUpdate(msg.notification);
          if (msg.deleted_ids) this._onDelete(msg.deleted_ids);
        },
        { type: "k93_ans/subscribe" }
      );
    } catch (err) {
      console.error("k93-ans-banner-card: failed to subscribe", err);
    }
  }

  async _fetchList() {
    try {
      const cfg = this._config || {};
      const result = await this._hass.callWS({
        type: "k93_ans/list",
        include_acknowledged: true,
        limit: cfg.max_items ?? 50,
        channels: cfg.channels && cfg.channels.length ? cfg.channels : undefined,
        channel_mode: cfg.channels_mode || "include",
        min_importance: cfg.min_importance,
      });
      this._notifications = result.notifications;
      this._render();
    } catch (err) {
      console.error("k93-ans-banner-card: failed to load notifications", err);
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

  _titleIconHtml() {
    const cfg = this._config;
    if (!cfg.title_icon) return "";
    const size = Number(cfg.title_icon_size) || 24;
    const color = cfg.title_icon_color || "var(--primary-text-color)";
    const background = cfg.title_icon_background || "transparent";
    return `
      <span class="title-icon" style="width: ${size}px; height: ${size}px; background: ${esc(background)};">
        <ha-icon icon="${esc(cfg.title_icon)}" style="color: ${esc(color)}; --mdc-icon-size: ${Math.round(size * 0.6)}px;"></ha-icon>
      </span>
    `;
  }

  _channelColor(record) {
    const hass = this._hass;
    if (!hass) return "";
    const cached = this._channelSensorId && hass.states[this._channelSensorId];
    const channels = cached
      ? cached.attributes.channels
      : (() => {
          for (const stateObj of Object.values(hass.states)) {
            if (stateObj.entity_id.startsWith("sensor.k93_ans") && Array.isArray(stateObj.attributes?.channels)) {
              this._channelSensorId = stateObj.entity_id;
              return stateObj.attributes.channels;
            }
          }
          return null;
        })();
    if (!Array.isArray(channels)) return "";
    const recordChannel = String(record.channel || "").toLowerCase();
    const match = channels.find((c) => String(c.key).toLowerCase() === recordChannel);
    return (match && match.color) || "";
  }

  _tickerItemHtml(record, locale, lang) {
    const icon = record.icon || "mdi:bell-outline";
    const channelColor = this._channelColor(record);
    const iconHtml = icon.startsWith("mdi:")
      ? `<ha-icon class="ticker-icon" icon="${esc(icon)}"${channelColor ? ` style="color: ${esc(channelColor)};"` : ""}></ha-icon>`
      : `<img class="ticker-icon-img" src="${esc(icon)}" alt="" />`;
    return (
      `<span class="ticker-item">${iconHtml}` +
      `<span class="ticker-text">${esc(formatRelativeTime(record.created, locale, lang))} : ${esc(record.message)}</span></span>`
    );
  }

  _renderTicker(locale, lang) {
    const cfg = this._config;
    const items = (this._notifications || [])
      .filter((n) => matchesFilter(n, cfg.channels, cfg.min_importance, cfg.channels_mode))
      .slice(0, cfg.ticker_limit ?? 10);

    if (!items.length) return "";

    const sep = `<span class="ticker-sep">&bull;</span>`;
    const group = items.map((n) => this._tickerItemHtml(n, locale, lang)).join(sep) + sep;
    const speed = Number(cfg.ticker_speed) || 1;
    const baseLoopSeconds = Math.min(items.length * 5, 120);
    const duration = Math.max(4, baseLoopSeconds / speed);
    const fontSize = Number(cfg.ticker_font_size) || 1;
    const iconHtml = this._titleIconHtml();

    return `
      <div class="ticker-wrap">
        ${iconHtml}
        <div class="ticker-viewport">
          <div class="ticker-track" style="animation-duration: ${duration}s; font-size: ${fontSize}em;">
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
        .title-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .ticker-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 10px 16px;
          box-sizing: border-box;
        }
        .ticker-viewport {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          white-space: nowrap;
          -webkit-mask-image: linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%);
          mask-image: linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%);
        }
        .ticker-track {
          display: inline-block;
          white-space: nowrap;
          animation-name: k93-ticker;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
          color: var(--primary-text-color);
          line-height: 1.4;
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
          --mdc-icon-size: 1em;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1em;
          height: 1em;
          color: var(--primary-text-color);
          flex-shrink: 0;
        }
        .ticker-icon-img {
          display: inline-block;
          width: 1em;
          height: 1em;
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
        @keyframes k93-ticker {
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
    }

    if (cardThemeStyles.length) {
      this._cardEl.setAttribute("style", cardThemeStyles.join("; "));
    } else {
      this._cardEl.removeAttribute("style");
    }

    if (tickerHtml !== this._lastTickerHtml) {
      this._lastTickerHtml = tickerHtml;
      this._tickerHostEl.innerHTML = tickerHtml;
    }
  }

  static getStubConfig() {
    return {
      title_icon: "mdi:bell-outline",
      title_icon_size: 24,
      title_icon_color: null,
      title_icon_background: null,
      language: "auto",
      channels: [],
      channels_mode: "include",
      min_importance: "low",
      ticker_limit: 10,
      ticker_font_size: 1,
      ticker_speed: 1,
      max_items: 50,
      card_height: null,
      card_background_color: null,
      card_border_radius: null,
      card_border_color: null,
      card_border_width: null,
    };
  }

  static getConfigElement() {
    return document.createElement("k93-ans-banner-card-editor");
  }
}

class K93AnsBannerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._updateForm();
  }

  set hass(hass) {
    this._hass = hass;
    this._updateForm();
  }

  connectedCallback() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (item) => K93AnsBannerCardEditor.LABELS[item.name] || item.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: this._config },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.appendChild(this._form);
    }
    this._updateForm();
  }

  _channelOptions() {
    const hass = this._hass;
    if (hass) {
      const cached = this._channelSensorId && hass.states[this._channelSensorId];
      const channels = cached
        ? cached.attributes.channels
        : (() => {
            for (const stateObj of Object.values(hass.states)) {
              if (stateObj.entity_id.startsWith("sensor.k93_ans") && Array.isArray(stateObj.attributes?.channels)) {
                this._channelSensorId = stateObj.entity_id;
                return stateObj.attributes.channels;
              }
            }
            return null;
          })();
      if (Array.isArray(channels)) {
        return channels.map((c) => ({
          value: c.key,
          label: c.enabled === false ? `${c.name} (${c.key}, disabled)` : `${c.name} (${c.key})`,
        }));
      }
    }
    return BUILTIN_CHANNEL_KEYS.map((key) => ({ value: key, label: key }));
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

    return [
      { name: "title_icon", selector: { icon: {} } },
      {
        name: "title_icon_size",
        selector: { number: { min: 12, max: 64, step: 1, mode: "box", unit_of_measurement: "px" } },
      },
      { name: "title_icon_color", selector: { text: {} } },
      { name: "title_icon_background", selector: { text: {} } },
      { name: "language", selector: languageSelector },
      { name: "channels_mode", selector: channelModeSelector },
      { name: "channels", selector: channelSelector },
      { name: "min_importance", selector: { select: { options: importanceOptions } } },
      { name: "ticker_limit", selector: { number: { min: 1, max: 500, mode: "box" } } },
      {
        name: "ticker_font_size",
        selector: { number: { min: 0.5, max: 3, step: 0.05, mode: "box" } },
      },
      {
        name: "ticker_speed",
        selector: { number: { min: 0.25, max: 4, step: 0.25, mode: "box" } },
      },
      { name: "max_items", selector: { number: { min: 1, max: 500, mode: "box" } } },
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

K93AnsBannerCardEditor.LABELS = {
  title_icon: "Title icon",
  title_icon_size: "Title icon size (px)",
  title_icon_color: "Title icon color (CSS color, blank = theme text color)",
  title_icon_background: "Title icon backdrop (CSS color, blank = none)",
  language: "Language",
  channels_mode: "Channel filter mode",
  channels: "Channels (empty = no filter; suggests configured channels)",
  min_importance: "Minimum importance",
  ticker_limit: "Max items in rotation",
  ticker_font_size: "Font size (em)",
  ticker_speed: "Scroll speed (x)",
  max_items: "Max records fetched",
  card_height: "Card height (px, blank = auto-fit to the ticker line)",
  card_background_color: "Card background color override (CSS color, blank = theme default)",
  card_border_radius: "Card corner radius override (px, blank = theme default)",
  card_border_color: "Card border color override (CSS color, blank = theme default)",
  card_border_width: "Card border width override (px, blank = theme default)",
};

customElements.define("k93-ans-banner-card", K93AnsBannerCard);
customElements.define("k93-ans-banner-card-editor", K93AnsBannerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "k93-ans-banner-card",
  name: "K93 ANS Banner Card",
  description: "A dedicated scrolling notification banner for the k93_ans integration, with no history/list sections.",
});
