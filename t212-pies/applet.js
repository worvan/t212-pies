const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Soup = imports.gi.Soup;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;

const REFRESH_INTERVAL = 60; // seconds
const API_BASE_URL = "https://live.trading212.com/api/v0";
const REQUEST_INTERVAL_MS = 10000; // minimum ms between API requests (T212 pie endpoints enforce ~1 req/10s)

const DEBUG = false;
function dbg(msg) { if (DEBUG) global.log("T212 [DEBUG] " + msg); }

const COLORS = {
    positive: '#4CAF50',
    negative: '#F44336',
    neutral: '#888888',
    primary: '#ffffff',
    secondary: '#9e9e9e',
    background: 'rgba(255, 255, 255, 0.04)',
    border: 'rgba(255, 255, 255, 0.08)',
    headerBg: 'rgba(255, 255, 255, 0.08)'
};

function Trading212Applet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

Trading212Applet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    _init: function(metadata, orientation, panel_height, instance_id) {
        Applet.TextIconApplet.prototype._init.call(this, orientation, panel_height, instance_id);

        this._meta = metadata;

        try {
            this.set_applet_icon_path(metadata.path + "/assets/icons/t212-pies.svg");
        } catch(e) {
            this.set_applet_icon_symbolic_name("view-statistics-symbolic");
        }
        let appletName = (metadata && metadata.name) || "Trading 212";
        this.set_applet_label(appletName);
        this.set_applet_tooltip(appletName);

        this.apiKey = null;
        this.httpSession = new Soup.Session();
        this.stocksData = [];
        this.piesData = {};  // keyed by pie ID
        this.instrumentNames = {};  // ticker -> human readable name
        this._timeoutId = null;
        this._requestQueue = [];
        this._requestInFlight = false;
        this._lastRequestTime = 0;
        this._paused = false;
        this._hideAmounts = false;

        this._loadApiKey();

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._createMenuLayout();

        if (this.apiKey) {
            this._fetchData();
            this._setupAutoRefresh();
        } else {
            this._updateStatus("Error: API key missing. Place key in 'api-key' file.");
        }
    },

    _loadApiKey: function() {
        try {
            let apiKeyFile = this._meta.path + "/api-key";
            dbg("Looking for API key at: " + apiKeyFile);
            if (GLib.file_test(apiKeyFile, GLib.FileTest.EXISTS)) {
                let [success, contents] = GLib.file_get_contents(apiKeyFile);
                if (success) {
                    this.apiKey = imports.byteArray.toString(contents).trim();
                    dbg("API key loaded, length: " + this.apiKey.length);
                } else {
                    global.logError("T212 Applet: Failed to read api-key file");
                }
            } else {
                global.logError("T212 Applet: api-key file not found at: " + apiKeyFile);
            }
        } catch (e) {
            global.logError("T212 Applet: Error loading API key: " + e.message);
        }
    },

    _createMenuLayout: function() {
        this.menu.removeAll();

        // 1. Portfolio summary banner item at the top (pinned)
        this.summaryBin = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'min-width: 380px; padding: 4px 8px 2px 8px;'
        });
        this.menu.addActor(this.summaryBin);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 2. Single Unified Scroll Area containing both Stocks and Pies sections
        let scrollView = new St.ScrollView({
            style: 'max-height: 420px; min-width: 380px;',
            x_expand: true,
            x_fill: true,
            y_fill: false,
            y_align: St.Align.START,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            enable_auto_scrolling: true
        });
        scrollView.set_clip_to_allocation(true);

        let vscroll = scrollView.get_vscroll_bar();
        vscroll.connect('scroll-start', Lang.bind(this, function() {
            this.menu.passEvents = true;
        }));
        vscroll.connect('scroll-stop', Lang.bind(this, function() {
            this.menu.passEvents = false;
        }));

        let contentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'padding: 2px 10px 4px 6px; spacing: 8px;'
        });
        scrollView.add_actor(contentBox);

        // --- STOCKS SECTION ---
        let stocksSection = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 4px;' });
        let stocksHeaderBox = new St.BoxLayout({ x_expand: true, y_align: St.Align.MIDDLE, style: 'padding: 4px 4px 2px 4px;' });
        
        let stocksHeaderLabel = new St.Label({
            text: "📈  STOCKS",
            style: "font-weight: bold; color: " + COLORS.secondary + "; font-size: 0.85em;"
        });
        stocksHeaderBox.add_actor(stocksHeaderLabel);

        this.stocksCountLabel = new St.Label({
            text: " (0)",
            style: "color: " + COLORS.neutral + "; font-size: 0.8em; margin-left: 2px;"
        });
        stocksHeaderBox.add_actor(this.stocksCountLabel);

        let stocksHeaderSpacer = new St.Widget({ x_expand: true });
        stocksHeaderBox.add(stocksHeaderSpacer, { expand: true, x_fill: true });

        this.stocksSubtotalLabel = new St.Label({
            text: "",
            style: "color: " + COLORS.secondary + "; font-size: 0.82em; font-weight: 600;",
            y_align: St.Align.MIDDLE
        });
        this.stocksSubtotalLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        stocksHeaderBox.add_actor(this.stocksSubtotalLabel);

        stocksSection.add_actor(stocksHeaderBox);

        this.stocksBin = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 6px;' });
        stocksSection.add_actor(this.stocksBin);
        contentBox.add_actor(stocksSection);

        // --- PIES SECTION ---
        let piesSection = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 4px;' });
        let piesHeaderBox = new St.BoxLayout({ x_expand: true, y_align: St.Align.MIDDLE, style: 'padding: 4px 4px 2px 4px;' });

        let piesHeaderLabel = new St.Label({
            text: "🥧  PIES",
            style: "font-weight: bold; color: " + COLORS.secondary + "; font-size: 0.85em;"
        });
        piesHeaderBox.add_actor(piesHeaderLabel);

        this.piesCountLabel = new St.Label({
            text: " (0)",
            style: "color: " + COLORS.neutral + "; font-size: 0.8em; margin-left: 2px;"
        });
        piesHeaderBox.add_actor(this.piesCountLabel);

        let piesHeaderSpacer = new St.Widget({ x_expand: true });
        piesHeaderBox.add(piesHeaderSpacer, { expand: true, x_fill: true });

        this.piesSubtotalLabel = new St.Label({
            text: "",
            style: "color: " + COLORS.secondary + "; font-size: 0.82em; font-weight: 600;",
            y_align: St.Align.MIDDLE
        });
        this.piesSubtotalLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        piesHeaderBox.add_actor(this.piesSubtotalLabel);

        piesSection.add_actor(piesHeaderBox);

        this.piesBin = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 6px;' });
        piesSection.add_actor(this.piesBin);
        contentBox.add_actor(piesSection);

        this.menu.addActor(scrollView);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 3. Bottom status and control footer bar (pinned)
        let bottomBin = new St.BoxLayout({
            x_expand: true,
            y_align: St.Align.MIDDLE,
            style: 'background-color: ' + COLORS.background + '; border: 1px solid ' + COLORS.border + '; ' +
                   'border-radius: 6px; padding: 6px 10px; margin: 2px 8px 4px 8px;'
        });

        // Status dot indicator
        this.statusDot = new St.Label({
            text: '●',
            style: 'color: ' + COLORS.neutral + '; font-size: 0.9em;',
            y_align: St.Align.MIDDLE
        });
        bottomBin.add_actor(this.statusDot);

        // Spacer between dot and label
        let dotSpacer = new St.Widget({ style: 'min-width: 6px;' });
        bottomBin.add_actor(dotSpacer);

        this.statusLabel = new St.Label({
            text: "Initializing...",
            style: 'color: ' + COLORS.secondary + '; font-size: 0.82em;',
            x_expand: true,
            y_align: St.Align.MIDDLE
        });
        this.statusLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        bottomBin.add(this.statusLabel, { expand: true, x_fill: true });

        // Toggle visibility button (hide/show amounts)
        let hideAmountsLabel = new St.Label({
            text: this._hideAmounts ? '👁 Show' : '👁 Hide',
            style: 'font-size: 0.8em; color: ' + COLORS.primary + ';',
            y_align: St.Align.MIDDLE
        });
        this._hideAmountsButton = new St.Button({
            child: hideAmountsLabel,
            style: 'padding: 3px 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; ' +
                   'background-color: rgba(255,255,255,0.06); margin-right: 4px;',
            can_focus: true,
            reactive: true,
            y_align: St.Align.MIDDLE
        });
        this._hideAmountsButton.connect('clicked', Lang.bind(this, this._toggleHideAmounts));
        this._hideAmountsLabel = hideAmountsLabel;
        bottomBin.add_actor(this._hideAmountsButton);

        // Refresh button
        let refreshLabel = new St.Label({
            text: '🔄 Refresh',
            style: 'font-size: 0.8em; color: ' + COLORS.primary + ';',
            y_align: St.Align.MIDDLE
        });
        this._refreshButton = new St.Button({
            child: refreshLabel,
            style: 'padding: 3px 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; ' +
                   'background-color: rgba(255,255,255,0.06); margin-right: 4px;',
            can_focus: true,
            reactive: true,
            y_align: St.Align.MIDDLE
        });
        this._refreshButton.connect('clicked', Lang.bind(this, function() {
            if (!this._paused) {
                this._fetchData();
            }
        }));
        bottomBin.add_actor(this._refreshButton);

        // Pause button
        let pauseLabel = new St.Label({
            text: '⏸ Pause',
            style: 'font-size: 0.8em; color: ' + COLORS.primary + ';',
            y_align: St.Align.MIDDLE
        });
        this._pauseButton = new St.Button({
            child: pauseLabel,
            style: 'padding: 3px 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; ' +
                   'background-color: rgba(255,255,255,0.06);',
            can_focus: true,
            reactive: true,
            y_align: St.Align.MIDDLE
        });
        this._pauseButton.connect('clicked', Lang.bind(this, this._togglePause));
        this._pauseLabel = pauseLabel;
        bottomBin.add_actor(this._pauseButton);

        this.menu.addActor(bottomBin);
    },

    _fetchData: function() {
        if (!this.apiKey) {
            this._updateStatus("Error: API key missing");
            return;
        }
        this._updateStatus("Fetching data...");
        this._fetchInstruments(Lang.bind(this, function() {
            this._fetchStocks(Lang.bind(this, function() {
                this._fetchPies();
            }));
        }));
    },

    _apiGet: function(endpoint, callback) {
        this._requestQueue.push({ endpoint: endpoint, callback: callback });
        this._processQueue();
    },

    _processQueue: function() {
        if (this._requestInFlight || this._requestQueue.length === 0) return;

        let now = Date.now();
        let elapsed = now - this._lastRequestTime;
        let delay = Math.max(0, REQUEST_INTERVAL_MS - elapsed);

        if (delay > 0) {
            Mainloop.timeout_add(delay, Lang.bind(this, function() {
                this._processQueue();
                return false;
            }));
            return;
        }

        let item = this._requestQueue.shift();
        this._requestInFlight = true;
        this._lastRequestTime = Date.now();
        this._doRequest(item.endpoint, item.callback);
    },

    _doRequest: function(endpoint, callback) {
        let url = API_BASE_URL + endpoint;
        dbg("GET " + url);
        let message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', this.apiKey);
        this.httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            this._requestInFlight = false;
            try {
                let bytes = session.send_and_read_finish(result);
                let statusCode = message.status_code;
                dbg("Response status for " + endpoint + ": " + statusCode);
                if (statusCode === 200) {
                    let rawText = imports.byteArray.toString(bytes.get_data());
                    dbg("Raw response for " + endpoint + ": " + rawText.substring(0, 500));
                    let data = JSON.parse(rawText);
                    callback(null, data, message.response_headers);
                } else if (statusCode === 429) {
                    let rawText = imports.byteArray.toString(bytes.get_data());
                    dbg("Error body for " + endpoint + ": " + rawText.substring(0, 500));
                    // Read x-ratelimit-reset header to know when to retry
                    let resetHeader = message.response_headers.get_one('x-ratelimit-reset');
                    let retryAfter = 10; // default fallback seconds
                    if (resetHeader) {
                        let resetTs = parseInt(resetHeader);
                        let nowTs = Math.floor(Date.now() / 1000);
                        retryAfter = Math.max(1, resetTs - nowTs + 1);
                    }
                    dbg("Rate limited on " + endpoint + ", retrying in " + retryAfter + "s (reset=" + resetHeader + ")");
                    Mainloop.timeout_add_seconds(retryAfter, Lang.bind(this, function() {
                        this._requestQueue.unshift({ endpoint: endpoint, callback: callback });
                        this._processQueue();
                        return false;
                    }));
                } else {
                    let rawText = imports.byteArray.toString(bytes.get_data());
                    global.logError("T212 Applet: HTTP " + statusCode + " for " + endpoint + ": " + rawText.substring(0, 500));
                    callback("HTTP " + statusCode, null);
                }
            } catch (e) {
                global.logError("T212 Applet: Exception in _doRequest for " + endpoint + ": " + e.message);
                callback(e.message, null);
            }
            this._processQueue();
        });
    },

    _fetchInstruments: function(callback) {
        // Instrument metadata changes rarely; fetch the ticker->name map only once.
        if (Object.keys(this.instrumentNames).length > 0) {
            if (callback) callback();
            return;
        }
        this._apiGet("/equity/metadata/instruments", Lang.bind(this, function(err, data) {
            if (err) {
                global.logError("T212 Applet: Instruments error: " + err);
                // Non-fatal: fall back to tickers if names are unavailable
                if (callback) callback();
                return;
            }
            let instruments = Array.isArray(data) ? data : (data.items || []);
            instruments.forEach(instr => {
                if (instr && instr.ticker) {
                    this.instrumentNames[instr.ticker] = instr.name || instr.shortName || instr.ticker;
                }
            });
            dbg("Instruments loaded: " + Object.keys(this.instrumentNames).length);
            if (callback) callback();
        }));
    },

    _fetchStocks: function(callback) {
        this._apiGet("/equity/portfolio", Lang.bind(this, function(err, data) {
            if (err) {
                global.logError("T212 Applet: Stocks error: " + err);
                this._updateStatus("Stocks error: " + err);
                if (callback) callback();
                return;
            }
            dbg("Stocks data type: " + (Array.isArray(data) ? "array" : typeof data));
            dbg("Stocks data keys: " + JSON.stringify(Object.keys(data || {})));
            // API returns { items: [...] } or directly an array
            this.stocksData = Array.isArray(data) ? data : (data.items || []);
            dbg("Stocks count: " + this.stocksData.length);
            if (this.stocksData.length > 0) {
                dbg("First stock keys: " + JSON.stringify(Object.keys(this.stocksData[0])));
                dbg("First stock: " + JSON.stringify(this.stocksData[0]));
            }
            this._updateStocksUI();
            if (callback) callback();
        }));
    },

    _fetchPies: function() {
        this._apiGet("/equity/pies", Lang.bind(this, function(err, data) {
            if (err) {
                global.logError("T212 Applet: Pies error: " + err);
                this._updateStatus("Pies error: " + err);
                return;
            }
            dbg("Pies list data type: " + (Array.isArray(data) ? "array" : typeof data));
            dbg("Pies list keys: " + JSON.stringify(Object.keys(data || {})));
            let piesList = Array.isArray(data) ? data : (data.items || []);
            dbg("Pies count: " + piesList.length);
            if (piesList.length > 0) {
                dbg("First pie: " + JSON.stringify(piesList[0]));
            }
            if (piesList.length === 0) {
                this.piesData = {};
                this._updatePiesUI();
                return;
            }
            // Update listData for each pie in-place (preserving existing detail data)
            piesList.forEach(pie => {
                if (!this.piesData[pie.id]) {
                    this.piesData[pie.id] = { detail: null, listData: pie };
                } else {
                    this.piesData[pie.id].listData = pie;
                }
            });
            // Remove stale pie IDs no longer in the list
            let activeIds = new Set(piesList.map(p => p.id.toString()));
            Object.keys(this.piesData).forEach(id => {
                if (!activeIds.has(id)) delete this.piesData[id];
            });
            this._updatePiesUI();
            // Fetch pie details sequentially with delays to avoid 429 rate limiting
            this._fetchPieDetailsSequentially(piesList, 0);
        }));
    },

    _fetchPieDetailsSequentially: function(piesList, index) {
        if (index >= piesList.length) {
            this._updatePiesUI();
            this._updateStatus("Updated: " + new Date().toLocaleTimeString());
            return;
        }
        let pie = piesList[index];
        this._apiGet("/equity/pies/" + pie.id, Lang.bind(this, function(err2, detail) {
            if (!err2 && detail) {
                dbg("Pie detail keys: " + JSON.stringify(Object.keys(detail)));
                // Update only this pie's entry, preserving all others
                if (!this.piesData[pie.id]) this.piesData[pie.id] = { detail: null, listData: pie };
                this.piesData[pie.id].detail = detail;
            } else {
                global.logError("T212 Applet: Pie detail error for id " + pie.id + ": " + err2);
                // leave existing entry unchanged (stale data is better than nothing)
            }
            this._updatePiesUI();
            this._fetchPieDetailsSequentially(piesList, index + 1);
        }));
    },

    _makeEmptyState: function(icon, message) {
        let empty = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: St.Align.MIDDLE,
            style: 'padding: 16px 12px; background-color: rgba(255,255,255,0.02); ' +
                   'border-radius: 6px; border: 1px dashed rgba(255,255,255,0.06);'
        });

        let iconLabel = new St.Label({
            text: icon,
            style: 'font-size: 1.5em; margin-bottom: 4px;',
            x_align: St.Align.MIDDLE
        });
        empty.add_actor(iconLabel);

        let msgLabel = new St.Label({
            text: message,
            style: 'color: ' + COLORS.secondary + '; font-size: 0.85em;',
            x_align: St.Align.MIDDLE
        });
        empty.add_actor(msgLabel);

        return empty;
    },

    _formatPrice: function(num) {
        // Format with thousands separator and 2 decimal places
        let parts = (num || 0).toFixed(2).split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        return parts.join('.');
    },

    // Cached card actors per section to avoid flickering on rebuild
    _updateCardList: function(bin, items, sectionKey) {
        if (!bin) return;

        // Store/retrieve cached card data for this section
        if (!this['_' + sectionKey + 'Cards']) this['_' + sectionKey + 'Cards'] = [];
        let cached = this['_' + sectionKey + 'Cards'];

        // If items is null, show empty state
        if (items === null || items.length === 0) {
            bin.destroy_all_children();
            cached.length = 0;
            let icon = sectionKey === 'stocks' ? '📈' : '🥧';
            let message = sectionKey === 'stocks' ? 'No standalone stocks in your portfolio' : 'No pies in your portfolio';
            let empty = this._makeEmptyState(icon, message);
            bin.add_actor(empty);
            return;
        }

        // If bin currently contains the empty state (which isn't in cached array), clear it
        if (cached.length === 0 && bin.get_children().length > 0) {
            bin.destroy_all_children();
        }

        // Update existing cards or create new ones as needed
        for (let i = 0; i < items.length; i++) {
            let item = items[i];
            if (i < cached.length && cached[i]) {
                // Update existing card in-place
                this._updateCard(cached[i], item.name, item.value, item.percent, item.subtext);
            } else {
                // Create new card
                let card = this._makeCard(item.name, item.value, item.percent, item.subtext);
                cached.push(card);
                bin.add_actor(card);
            }
        }
        // Remove extra cards if list shrank
        while (cached.length > items.length) {
            let old = cached.pop();
            if (old.parent) old.parent.remove_actor(old);
            old.destroy();
        }
    },

    _updateCard: function(card, name, value, percent, subtext) {
        // Fixed DOM structure: card (BoxLayout) > [topRow, rowSpacer, bottomRow]
        // topRow: [nameLabel, topSpacer, percentBadge]
        // bottomRow: [subLabel, bottomSpacer, valueLabel]
        if (!card) return;

        let topRow = card.first_child;
        let rowSpacer = topRow ? topRow.get_next_sibling() : null;
        let bottomRow = rowSpacer ? rowSpacer.get_next_sibling() : null;

        // Update top row
        if (topRow) {
            let nameLabel = topRow.first_child;
            if (nameLabel) nameLabel.set_text(name || 'Unknown');

            let topSpacer = nameLabel ? nameLabel.get_next_sibling() : null;
            let badge = topSpacer ? topSpacer.get_next_sibling() : null;
            if (badge) {
                let color = percent >= 0 ? COLORS.positive : COLORS.negative;
                let sign = percent >= 0 ? '+' : '';
                let bgColor = percent >= 0 ? 'rgba(76, 175, 80, 0.18)' : 'rgba(244, 67, 54, 0.18)';
                badge.set_text(sign + (percent || 0).toFixed(2) + '%');
                badge.set_style('color: ' + color + '; font-weight: bold; font-size: 0.85em; ' +
                                'background-color: ' + bgColor + '; ' +
                                'padding: 2px 7px; border-radius: 4px;');
            }
        }

        // Update bottom row
        if (bottomRow) {
            let subLabel = bottomRow.first_child;
            if (subLabel) subLabel.set_text(subtext || '');

            let bottomSpacer = subLabel ? subLabel.get_next_sibling() : null;
            let valLabel = bottomSpacer ? bottomSpacer.get_next_sibling() : null;
            if (valLabel) valLabel.set_text(value + ' CZK');
        }
    },

    _makeCard: function(name, value, percent, subtext) {
        // Vertical column inside card as the card actor directly
        let card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'background-color: ' + COLORS.background + '; border-radius: 8px; ' +
                   'padding: 10px 12px; border: 1px solid ' + COLORS.border + ';'
        });

        // Top row: name + percentage badge
        let topRow = new St.BoxLayout({ x_expand: true, y_align: St.Align.MIDDLE });
        card.add_actor(topRow);

        let nameLabel = new St.Label({
            text: name || 'Unknown',
            style: 'font-weight: 600; font-size: 0.95em; color: ' + COLORS.primary + ';',
            x_expand: true,
            y_align: St.Align.MIDDLE
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add(nameLabel, { expand: true, x_fill: true });

        // Explicit spacer between name and badge (minimum 10px)
        let topSpacer = new St.Widget({ style: 'min-width: 10px;' });
        topRow.add_actor(topSpacer);

        let color = percent >= 0 ? COLORS.positive : COLORS.negative;
        let sign = percent >= 0 ? '+' : '';
        let bgColor = percent >= 0 ? 'rgba(76, 175, 80, 0.18)' : 'rgba(244, 67, 54, 0.18)';
        let percentBadge = new St.Label({
            text: sign + (percent || 0).toFixed(2) + '%',
            style: 'color: ' + color + '; font-weight: bold; font-size: 0.85em; ' +
                   'background-color: ' + bgColor + '; ' +
                   'padding: 2px 7px; border-radius: 4px;',
            y_align: St.Align.MIDDLE
        });
        topRow.add_actor(percentBadge);

        // Explicit vertical row spacer (5px)
        let rowSpacer = new St.Widget({ style: 'min-height: 5px;' });
        card.add_actor(rowSpacer);

        // Bottom row: subtext + value
        let bottomRow = new St.BoxLayout({ x_expand: true, y_align: St.Align.MIDDLE });
        card.add_actor(bottomRow);

        let subLabel = new St.Label({
            text: subtext || '',
            style: 'color: ' + COLORS.secondary + '; font-size: 0.82em;',
            x_expand: true,
            y_align: St.Align.MIDDLE
        });
        subLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        bottomRow.add(subLabel, { expand: true, x_fill: true });

        // Explicit spacer between subtext and value (minimum 10px)
        let bottomSpacer = new St.Widget({ style: 'min-width: 10px;' });
        bottomRow.add_actor(bottomSpacer);

        let valueLabel = new St.Label({
            text: value + ' CZK',
            style: 'color: #e0e0e0; font-size: 0.9em; font-weight: 600;',
            y_align: St.Align.MIDDLE
        });
        bottomRow.add_actor(valueLabel);

        return card;
    },

    _calcStockValuesCZK: function(stock) {
        let currentPrice = stock.currentPrice || 0;
        let avgPrice     = stock.averagePrice  || 0;
        let quantity     = stock.quantity      || 0;
        let ppl          = stock.ppl           || 0;
        let fxPpl        = stock.fxPpl         || 0;
        let priceDiff    = currentPrice - avgPrice;
        let currentValueCZK, paidCZK;
        // Derive FX rate from ppl (account currency, CZK) and fxPpl (FX component)
        // ppl = (currentPrice - avgPrice) * quantity * fxRate + fxPpl
        // => fxRate = (ppl - fxPpl) / (priceDiff * quantity)
        if (Math.abs(priceDiff) > 0.0001 && quantity > 0) {
            let fxRate      = (ppl - fxPpl) / (priceDiff * quantity);
            currentValueCZK = currentPrice * quantity * fxRate;
            paidCZK         = avgPrice     * quantity * fxRate;
        } else {
            // prices equal or no quantity: invested CZK + ppl
            currentValueCZK = avgPrice * quantity + ppl;
            paidCZK         = avgPrice * quantity;
        }
        return { currentValueCZK, paidCZK };
    },

    _updateStocksUI: function() {
        dbg("_updateStocksUI called, count: " + (this.stocksData ? this.stocksData.length : 'null'));

        let standaloneStocks = (this.stocksData || []).filter(s => !(s.pieQuantity > 0));

        // Build an array of { name, value, percent, subtext } for current data
        let items = [];
        if (standaloneStocks.length === 0) {
            items = null; // signal empty state
        } else {
            standaloneStocks.forEach(stock => {
                let { currentValueCZK, paidCZK } = this._calcStockValuesCZK(stock);
                let currentPrice = stock.currentPrice || 0;
                let avgPrice = stock.averagePrice || 0;
                let percent = avgPrice !== 0 ? ((currentPrice - avgPrice) / avgPrice * 100) : 0;
                let ticker = stock.ticker || "?";
                let name = this.instrumentNames[ticker] || ticker;
                
                let subtext = ticker;
                if (paidCZK > 0) {
                    let paidStr = this._hideAmounts ? '••••' : this._formatPrice(paidCZK);
                    subtext += ' • Paid: ' + paidStr + ' CZK';
                }

                let valueStr = this._hideAmounts ? '••••' : this._formatPrice(currentValueCZK);

                items.push({
                    name: name,
                    value: valueStr,
                    percent: percent,
                    subtext: subtext
                });
            });
        }
        this._updateCardList(this.stocksBin, items, "stocks");
        this._updateSummaryUI();
    },

    _updatePiesUI: function() {
        let pieEntries = this.piesData ? Object.values(this.piesData) : [];
        dbg("_updatePiesUI called, count: " + pieEntries.length);

        // Build an array of { name, value, percent, subtext } for current data
        let items = [];
        if (pieEntries.length === 0) {
            items = null; // signal empty state
        } else {
            pieEntries.forEach(pie => {
                let name = "Unnamed Pie";
                if (pie.detail && pie.detail.settings && pie.detail.settings.name) {
                    name = pie.detail.settings.name;
                } else if (pie.listData && pie.listData.settings && pie.listData.settings.name) {
                    name = pie.listData.settings.name;
                } else if (pie.listData && pie.listData.name) {
                    name = pie.listData.name;
                }

                // Use list data result: priceAvgValue = current value, priceAvgResultCoef = gain/loss ratio
                let listResult = (pie.listData && pie.listData.result) || {};
                let totalValue = listResult.priceAvgValue || 0;
                let coef = listResult.priceAvgResultCoef != null ? listResult.priceAvgResultCoef : 0;
                let percent = coef * 100;
                let paid = (1 + coef) !== 0 ? totalValue / (1 + coef) : totalValue;

                let subtext = '';
                if (pie.detail && pie.detail.instruments && Array.isArray(pie.detail.instruments)) {
                    let count = pie.detail.instruments.length;
                    subtext = count + (count === 1 ? ' instrument' : ' instruments');
                }
                if (paid > 0) {
                    let paidStr = this._hideAmounts ? '••••' : this._formatPrice(paid);
                    subtext = (subtext ? subtext + ' • ' : '') + 'Paid: ' + paidStr + ' CZK';
                }
                if (!subtext) {
                    subtext = 'Pie Portfolio';
                }

                let valueStr = this._hideAmounts ? '••••' : this._formatPrice(totalValue);

                items.push({
                    name: name,
                    value: valueStr,
                    percent: percent,
                    subtext: subtext
                });
            });
        }
        this._updateCardList(this.piesBin, items, "pies");
        this._updateSummaryUI();
    },

    _updateSummaryUI: function() {
        if (!this.summaryBin) return;
        this.summaryBin.destroy_all_children();

        // --- stocks contribution ---
        let stocksPaid = 0;
        let stocksCurrent = 0;
        let stocksCount = 0;
        let standaloneStocks = (this.stocksData || []).filter(s => !(s.pieQuantity > 0));
        standaloneStocks.forEach(stock => {
            let { currentValueCZK, paidCZK } = this._calcStockValuesCZK(stock);
            stocksCurrent += currentValueCZK;
            stocksPaid += paidCZK;
            stocksCount++;
        });

        // --- pies contribution ---
        let piesCurrent = 0;
        let piesPaid = 0;
        let piesCount = 0;
        let pieEntries = this.piesData ? Object.values(this.piesData) : [];
        pieEntries.forEach(pie => {
            let listResult = (pie.listData && pie.listData.result) || {};
            let currentVal = listResult.priceAvgValue || 0;
            let coef = listResult.priceAvgResultCoef != null ? listResult.priceAvgResultCoef : 0;
            // currentVal = paid * (1 + coef)  =>  paid = currentVal / (1 + coef)
            let paid = (1 + coef) !== 0 ? currentVal / (1 + coef) : currentVal;
            piesCurrent += currentVal;
            piesPaid += paid;
            piesCount++;
        });

        let totalPaid = stocksPaid + piesPaid;
        let totalCurrent = stocksCurrent + piesCurrent;
        let totalProfitLoss = totalCurrent - totalPaid;
        let totalPercent = totalPaid > 0 ? ((totalProfitLoss / totalPaid) * 100) : 0;

        // Update Section Headers with count and subtotals
        if (this.stocksCountLabel) {
            this.stocksCountLabel.set_text(' (' + stocksCount + ')');
        }
        if (this.stocksSubtotalLabel) {
            let stocksPpl = stocksCurrent - stocksPaid;
            let stocksPercent = stocksPaid > 0 ? (stocksPpl / stocksPaid * 100) : 0;
            let sign = stocksPercent >= 0 ? '+' : '';
            let stocksValStr = this._hideAmounts ? '••••' : this._formatPrice(stocksCurrent);
            this.stocksSubtotalLabel.set_text(stocksValStr + ' CZK (' + sign + stocksPercent.toFixed(1) + '%)');
        }

        if (this.piesCountLabel) {
            this.piesCountLabel.set_text(' (' + piesCount + ')');
        }
        if (this.piesSubtotalLabel) {
            let piesPpl = piesCurrent - piesPaid;
            let piesPercent = piesPaid > 0 ? (piesPpl / piesPaid * 100) : 0;
            let sign = piesPercent >= 0 ? '+' : '';
            let piesValStr = this._hideAmounts ? '••••' : this._formatPrice(piesCurrent);
            this.piesSubtotalLabel.set_text(piesValStr + ' CZK (' + sign + piesPercent.toFixed(1) + '%)');
        }

        // Summary banner card at the top
        let banner = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'background-color: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); ' +
                   'border-radius: 8px; padding: 12px 14px;'
        });

        // Header row: "PORTFOLIO BALANCE" + Return badge
        let topRow = new St.BoxLayout({ x_expand: true, y_align: St.Align.MIDDLE });
        banner.add_actor(topRow);

        let titleLabel = new St.Label({
            text: 'PORTFOLIO BALANCE',
            style: 'font-weight: bold; font-size: 0.78em; color: ' + COLORS.secondary + ';',
            x_expand: true,
            y_align: St.Align.MIDDLE
        });
        topRow.add(titleLabel, { expand: true, x_fill: true });

        let color = totalPercent >= 0 ? COLORS.positive : COLORS.negative;
        let sign = totalPercent >= 0 ? '+' : '';
        let bgColor = totalPercent >= 0 ? 'rgba(76, 175, 80, 0.18)' : 'rgba(244, 67, 54, 0.18)';
        let percentBadge = new St.Label({
            text: sign + totalPercent.toFixed(2) + '%',
            style: 'color: ' + color + '; font-weight: bold; font-size: 0.85em; ' +
                   'background-color: ' + bgColor + '; padding: 2px 8px; border-radius: 4px;',
            y_align: St.Align.MIDDLE
        });
        topRow.add_actor(percentBadge);

        // Spacer
        let spacer1 = new St.Widget({ style: 'min-height: 4px;' });
        banner.add_actor(spacer1);

        // Balance row: Large Current Balance
        let balanceRow = new St.BoxLayout({ x_expand: true, y_align: St.Align.MIDDLE });
        banner.add_actor(balanceRow);

        let balanceStr = this._hideAmounts ? '••••' : this._formatPrice(totalCurrent);
        let balanceLabel = new St.Label({
            text: balanceStr + ' CZK',
            style: 'font-weight: bold; font-size: 1.35em; color: ' + COLORS.primary + ';',
            x_expand: true,
            y_align: St.Align.MIDDLE
        });
        balanceRow.add(balanceLabel, { expand: true, x_fill: true });

        // Spacer
        let spacer2 = new St.Widget({ style: 'min-height: 6px;' });
        banner.add_actor(spacer2);

        // Bottom Details row: Profit/Loss Amount and Invested Amount
        let bottomRow = new St.BoxLayout({ x_expand: true, y_align: St.Align.MIDDLE });
        banner.add_actor(bottomRow);

        let pplSign = totalProfitLoss >= 0 ? '+' : '';
        let pplStr = this._hideAmounts ? '••••' : (pplSign + this._formatPrice(totalProfitLoss));
        let pplLabel = new St.Label({
            text: pplStr + ' CZK',
            style: 'color: ' + color + '; font-weight: 600; font-size: 0.85em;',
            y_align: St.Align.MIDDLE
        });
        bottomRow.add_actor(pplLabel);

        let dotSpacer = new St.Label({
            text: '  •  ',
            style: 'color: #555555; font-size: 0.85em;',
            y_align: St.Align.MIDDLE
        });
        bottomRow.add_actor(dotSpacer);

        let paidStr = this._hideAmounts ? '••••' : this._formatPrice(totalPaid);
        let paidLabel = new St.Label({
            text: 'Invested: ' + paidStr + ' CZK',
            style: 'color: ' + COLORS.secondary + '; font-size: 0.85em;',
            x_expand: true,
            y_align: St.Align.MIDDLE
        });
        bottomRow.add(paidLabel, { expand: true, x_fill: true });

        this.summaryBin.add_actor(banner);

        // Keep applet label as a suitable name for privacy before opening
        let appletName = (this._meta && this._meta.name) || "Trading 212";
        this.set_applet_label(appletName);
        this.set_applet_tooltip(appletName);
    },

    _toggleHideAmounts: function() {
        this._hideAmounts = !this._hideAmounts;
        if (this._hideAmountsLabel) {
            this._hideAmountsLabel.set_text(this._hideAmounts ? '👁 Show' : '👁 Hide');
        }
        this._updateStocksUI();
        this._updatePiesUI();
    },

    _togglePause: function() {
        this._paused = !this._paused;
        if (this._paused) {
            this._pauseLabel.set_text('▶ Resume');
            if (this._timeoutId) {
                Mainloop.source_remove(this._timeoutId);
                this._timeoutId = null;
            }
            this._requestQueue = [];
            this._updateStatus("Paused");
        } else {
            this._pauseLabel.set_text('⏸ Pause');
            this._fetchData();
            this._setupAutoRefresh();
        }
    },

    _setupAutoRefresh: function() {
        if (this._timeoutId) {
            Mainloop.source_remove(this._timeoutId);
        }
        this._timeoutId = Mainloop.timeout_add_seconds(REFRESH_INTERVAL, Lang.bind(this, function() {
            if (!this._paused) {
                this._fetchData();
            }
            return true;
        }));
    },

    _updateStatus: function(text) {
        if (this.statusLabel) {
            this.statusLabel.set_text(text);
        }
        // Update status dot color based on state
        if (this.statusDot) {
            let lower = text.toLowerCase();
            if (lower.indexOf('error') >= 0 || lower.indexOf('fail') >= 0) {
                this.statusDot.set_style('color: ' + COLORS.negative + '; font-size: 0.9em;');
            } else if (lower.indexOf('fetch') >= 0 || lower.indexOf('initializ') >= 0) {
                this.statusDot.set_style('color: #FFC107; font-size: 0.9em;');
            } else if (lower.indexOf('pause') >= 0) {
                this.statusDot.set_style('color: ' + COLORS.neutral + '; font-size: 0.9em;');
            } else {
                this.statusDot.set_style('color: ' + COLORS.positive + '; font-size: 0.9em;');
            }
        }
    },

    on_applet_clicked: function() {
        this.menu.toggle();
    },

    on_applet_removed_from_panel: function() {
        if (this._timeoutId) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._requestQueue = [];
        this.httpSession.abort();
        // Clean up cached cards
        if (this._stocksCards) {
            this._stocksCards.forEach(c => { if (c.parent) c.parent.remove_actor(c); c.destroy(); });
            this._stocksCards = null;
        }
        if (this._piesCards) {
            this._piesCards.forEach(c => { if (c.parent) c.parent.remove_actor(c); c.destroy(); });
            this._piesCards = null;
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new Trading212Applet(metadata, orientation, panel_height, instance_id);
}
