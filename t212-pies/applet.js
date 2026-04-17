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
        this.set_applet_label("T212 applet");
        this.set_applet_tooltip("Trading 212 Monitor");

        this.apiKey = null;
        this.httpSession = new Soup.Session();
        this.stocksData = [];
        this.piesData = {};  // keyed by pie ID
        this._timeoutId = null;
        this._requestQueue = [];
        this._requestInFlight = false;
        this._lastRequestTime = 0;
        this._paused = false;

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
            global.log("T212 [DEBUG] Looking for API key at: " + apiKeyFile);
            if (GLib.file_test(apiKeyFile, GLib.FileTest.EXISTS)) {
                let [success, contents] = GLib.file_get_contents(apiKeyFile);
                if (success) {
                    this.apiKey = imports.byteArray.toString(contents).trim();
                    global.log("T212 [DEBUG] API key loaded, length: " + this.apiKey.length);
                } else {
                    global.logError("T212 [DEBUG] Failed to read api-key file");
                }
            } else {
                global.logError("T212 [DEBUG] api-key file not found at: " + apiKeyFile);
            }
        } catch (e) {
            global.logError("T212 Applet: Error loading API key: " + e.message);
        }
    },

    _createMenuLayout: function() {
        this.menu.removeAll();

        // Stocks section header
        let stocksHeader = new PopupMenu.PopupMenuItem("── STOCKS ──", { reactive: false });
        stocksHeader.label.set_style("font-weight: bold; color: #aaaaaa;");
        this.menu.addMenuItem(stocksHeader);

        // Stocks scroll area
        this.stocksBin = new St.BoxLayout({ vertical: true, x_expand: true });
        let stocksScroll = new St.ScrollView({
            style: 'max-height: 250px;',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC
        });
        stocksScroll.add_actor(this.stocksBin);
        this.menu.box.add(stocksScroll, { expand: true, x_fill: true, y_fill: false });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Pies section header
        let piesHeader = new PopupMenu.PopupMenuItem("── PIES ──", { reactive: false });
        piesHeader.label.set_style("font-weight: bold; color: #aaaaaa;");
        this.menu.addMenuItem(piesHeader);

        // Pies scroll area
        this.piesBin = new St.BoxLayout({ vertical: true, x_expand: true });
        let piesScroll = new St.ScrollView({
            style: 'max-height: 250px;',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC
        });
        piesScroll.add_actor(this.piesBin);
        this.menu.box.add(piesScroll, { expand: true, x_fill: true, y_fill: false });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Portfolio summary section
        let summaryHeader = new PopupMenu.PopupMenuItem("── PORTFOLIO SUMMARY ──", { reactive: false });
        summaryHeader.label.set_style("font-weight: bold; color: #aaaaaa;");
        this.menu.addMenuItem(summaryHeader);

        this.summaryBin = new St.BoxLayout({ vertical: true, x_expand: true });
        this.menu.box.add(this.summaryBin, { expand: true, x_fill: true, y_fill: false });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Bottom bar: status text on the left, pause/play button on the right
        let bottomItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: '' });
        bottomItem.actor.set_style('padding: 0;');
        let bottomBox = new St.BoxLayout({ style: 'padding: 2px 4px;', x_expand: true });

        this.statusLabel = new St.Label({
            text: "Initializing...",
            style: 'color: #888888; font-size: 0.85em; min-width: 200px;'
        });
        this.statusLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        bottomBox.add_actor(this.statusLabel);

        // Spacer to push button to the right
        let spacer = new St.Widget({ x_expand: true, style: 'min-width: 20px;' });
        bottomBox.add_actor(spacer);

        this._pauseButton = new St.Button({
            label: '⏸ Pause',
            style: 'padding: 2px 12px; border: 1px solid #555; border-radius: 4px; font-size: 0.85em;',
            can_focus: true,
            reactive: true
        });
        this._pauseButton.connect('clicked', Lang.bind(this, this._togglePause));
        bottomBox.add_actor(this._pauseButton);

        bottomItem.addActor(bottomBox, { expand: true, span: -1 });
        this.menu.addMenuItem(bottomItem);

    },

    _fetchData: function() {
        if (!this.apiKey) {
            this._updateStatus("Error: API key missing");
            return;
        }
        this._updateStatus("Fetching data...");
        this._fetchStocks(Lang.bind(this, function() {
            this._fetchPies();
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
        global.log("T212 [DEBUG] GET " + url);
        let message = Soup.Message.new('GET', url);
        message.request_headers.append('Authorization', this.apiKey);
        this.httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            this._requestInFlight = false;
            try {
                let bytes = session.send_and_read_finish(result);
                let statusCode = message.status_code;
                global.log("T212 [DEBUG] Response status for " + endpoint + ": " + statusCode);
                if (statusCode === 200) {
                    let rawText = imports.byteArray.toString(bytes.get_data());
                    global.log("T212 [DEBUG] Raw response for " + endpoint + ": " + rawText.substring(0, 500));
                    let data = JSON.parse(rawText);
                    callback(null, data, message.response_headers);
                } else if (statusCode === 429) {
                    let rawText = imports.byteArray.toString(bytes.get_data());
                    global.logError("T212 [DEBUG] Error body for " + endpoint + ": " + rawText.substring(0, 500));
                    // Read x-ratelimit-reset header to know when to retry
                    let resetHeader = message.response_headers.get_one('x-ratelimit-reset');
                    let retryAfter = 10; // default fallback seconds
                    if (resetHeader) {
                        let resetTs = parseInt(resetHeader);
                        let nowTs = Math.floor(Date.now() / 1000);
                        retryAfter = Math.max(1, resetTs - nowTs + 1);
                    }
                    global.log("T212 [DEBUG] Rate limited on " + endpoint + ", retrying in " + retryAfter + "s (reset=" + resetHeader + ")");
                    Mainloop.timeout_add_seconds(retryAfter, Lang.bind(this, function() {
                        this._requestQueue.unshift({ endpoint: endpoint, callback: callback });
                        this._processQueue();
                        return false;
                    }));
                } else {
                    let rawText = imports.byteArray.toString(bytes.get_data());
                    global.logError("T212 [DEBUG] Error body for " + endpoint + ": " + rawText.substring(0, 500));
                    callback("HTTP " + statusCode, null);
                }
            } catch (e) {
                global.logError("T212 [DEBUG] Exception in _doRequest for " + endpoint + ": " + e.message);
                callback(e.message, null);
            }
            this._processQueue();
        });
    },

    _fetchStocks: function(callback) {
        this._apiGet("/equity/portfolio", Lang.bind(this, function(err, data) {
            if (err) {
                global.logError("T212 Applet: Stocks error: " + err);
                this._updateStatus("Stocks error: " + err);
                if (callback) callback();
                return;
            }
            global.log("T212 [DEBUG] Stocks data type: " + (Array.isArray(data) ? "array" : typeof data));
            global.log("T212 [DEBUG] Stocks data keys: " + JSON.stringify(Object.keys(data || {})));
            // API returns { items: [...] } or directly an array
            this.stocksData = Array.isArray(data) ? data : (data.items || []);
            global.log("T212 [DEBUG] Stocks count: " + this.stocksData.length);
            if (this.stocksData.length > 0) {
                global.log("T212 [DEBUG] First stock keys: " + JSON.stringify(Object.keys(this.stocksData[0])));
                global.log("T212 [DEBUG] First stock: " + JSON.stringify(this.stocksData[0]));
            }
            this._updateStocksUI();
            this._updateStatus("Updated: " + new Date().toLocaleTimeString());
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
            global.log("T212 [DEBUG] Pies list data type: " + (Array.isArray(data) ? "array" : typeof data));
            global.log("T212 [DEBUG] Pies list keys: " + JSON.stringify(Object.keys(data || {})));
            let piesList = Array.isArray(data) ? data : (data.items || []);
            global.log("T212 [DEBUG] Pies count: " + piesList.length);
            if (piesList.length > 0) {
                global.log("T212 [DEBUG] First pie: " + JSON.stringify(piesList[0]));
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
            let activeIds = piesList.map(p => p.id.toString());
            Object.keys(this.piesData).forEach(id => {
                if (activeIds.indexOf(id) === -1) delete this.piesData[id];
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
                global.log("T212 [DEBUG] Pie detail keys: " + JSON.stringify(Object.keys(detail)));
                // Update only this pie's entry, preserving all others
                if (!this.piesData[pie.id]) this.piesData[pie.id] = { detail: null, listData: pie };
                this.piesData[pie.id].detail = detail;
            } else {
                global.logError("T212 [DEBUG] Pie detail error for id " + pie.id + ": " + err2);
                // leave existing entry unchanged (stale data is better than nothing)
            }
            this._updatePiesUI();
            this._fetchPieDetailsSequentially(piesList, index + 1);
        }));
    },

    _formatPrice: function(num) {
        // Format with thousands separator and 2 decimal places
        let parts = num.toFixed(2).split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        return parts.join('.');
    },

    _makeRow: function(name, value, percent) {
        let row = new St.BoxLayout({
            style: 'padding: 5px 10px;',
            x_expand: true
        });

        let nameLabel = new St.Label({
            text: name,
            style: 'font-weight: bold;',
            x_expand: true
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add(nameLabel, { expand: true, x_fill: true });

        let valueLabel = new St.Label({
            text: value,
            style: 'text-align: right; min-width: 120px;'
        });
        row.add_actor(valueLabel);

        let color = percent >= 0 ? '#4CAF50' : '#F44336';
        let sign = percent >= 0 ? '+' : '';
        let percentLabel = new St.Label({
            text: sign + percent.toFixed(2) + '%',
            style: 'text-align: right; min-width: 70px; color: ' + color + ';'
        });
        row.add_actor(percentLabel);

        return row;
    },

    _updateStocksUI: function() {
        global.log("T212 [DEBUG] _updateStocksUI called, count: " + (this.stocksData ? this.stocksData.length : 'null'));
        this.stocksBin.destroy_all_children();
        if (!this.stocksData || this.stocksData.length === 0) {
            this.stocksBin.add_actor(new St.Label({ text: "No stocks found", style: 'padding: 8px 10px; color: #888;' }));
            return;
        }

        let standaloneStocks = this.stocksData.filter(s => !(s.pieQuantity > 0));
        if (standaloneStocks.length === 0) {
            this.stocksBin.add_actor(new St.Label({ text: "No standalone stocks", style: 'padding: 8px 10px; color: #888;' }));
            return;
        }
        standaloneStocks.forEach(stock => {
            let currentPrice = stock.currentPrice || 0;
            let avgPrice = stock.averagePrice || 0;
            let quantity = stock.quantity || 0;
            let ppl = stock.ppl || 0;
            let fxPpl = stock.fxPpl || 0;
            let priceDiff = currentPrice - avgPrice;
            let currentValueCZK;
            // Derive FX rate from ppl (account currency, CZK) and fxPpl (FX component)
            // ppl = (currentPrice - avgPrice) * quantity * fxRate + fxPpl
            // => fxRate = (ppl - fxPpl) / (priceDiff * quantity)
            if (Math.abs(priceDiff) > 0.0001 && quantity > 0) {
                let fxRate = (ppl - fxPpl) / (priceDiff * quantity);
                currentValueCZK = currentPrice * quantity * fxRate;
            } else {
                // prices equal or no quantity: invested CZK + ppl
                currentValueCZK = avgPrice * quantity + ppl;
            }
            let percent = avgPrice !== 0 ? ((currentPrice - avgPrice) / avgPrice * 100) : 0;
            let ticker = stock.ticker || "?";
            let row = this._makeRow(ticker, this._formatPrice(currentValueCZK), percent);
            this.stocksBin.add_actor(row);
        });
        this._updateSummaryUI();
    },

    _updatePiesUI: function() {
        let pieEntries = this.piesData ? Object.values(this.piesData) : [];
        global.log("T212 [DEBUG] _updatePiesUI called, count: " + pieEntries.length);
        this.piesBin.destroy_all_children();
        if (pieEntries.length === 0) {
            this.piesBin.add_actor(new St.Label({ text: "No pies found", style: 'padding: 8px 10px; color: #888;' }));
            return;
        }

        pieEntries.forEach(pie => {
            let name = "Unnamed Pie";
            if (pie.detail && pie.detail.settings && pie.detail.settings.name) {
                name = pie.detail.settings.name;
            }

            // Use list data result: priceAvgValue = current value, priceAvgResultCoef = gain/loss ratio
            let listResult = (pie.listData && pie.listData.result) || {};
            let totalValue = listResult.priceAvgValue || 0;
            let percent = listResult.priceAvgResultCoef != null ? (listResult.priceAvgResultCoef * 100) : 0;

            let row = this._makeRow(name, this._formatPrice(totalValue), percent);
            this.piesBin.add_actor(row);
        });
        this._updateSummaryUI();
    },

    _updateSummaryUI: function() {
        if (!this.summaryBin) return;
        this.summaryBin.destroy_all_children();

        // --- stocks contribution ---
        let stocksPaid = 0;
        let stocksCurrent = 0;
        let standaloneStocks = (this.stocksData || []).filter(s => !(s.pieQuantity > 0));
        standaloneStocks.forEach(stock => {
            let currentPrice = stock.currentPrice || 0;
            let avgPrice = stock.averagePrice || 0;
            let quantity = stock.quantity || 0;
            let ppl = stock.ppl || 0;
            let fxPpl = stock.fxPpl || 0;
            let priceDiff = currentPrice - avgPrice;
            let currentValueCZK, paidCZK;
            if (Math.abs(priceDiff) > 0.0001 && quantity > 0) {
                let fxRate = (ppl - fxPpl) / (priceDiff * quantity);
                currentValueCZK = currentPrice * quantity * fxRate;
                paidCZK = avgPrice * quantity * fxRate;
            } else {
                currentValueCZK = avgPrice * quantity + ppl;
                paidCZK = avgPrice * quantity;
            }
            stocksCurrent += currentValueCZK;
            stocksPaid += paidCZK;
        });

        // --- pies contribution ---
        let piesCurrent = 0;
        let piesPaid = 0;
        let pieEntries = this.piesData ? Object.values(this.piesData) : [];
        pieEntries.forEach(pie => {
            let listResult = (pie.listData && pie.listData.result) || {};
            let currentVal = listResult.priceAvgValue || 0;
            let coef = listResult.priceAvgResultCoef != null ? listResult.priceAvgResultCoef : 0;
            // currentVal = paid * (1 + coef)  =>  paid = currentVal / (1 + coef)
            let paid = (1 + coef) !== 0 ? currentVal / (1 + coef) : currentVal;
            piesCurrent += currentVal;
            piesPaid += paid;
        });

        let totalPaid = stocksPaid + piesPaid;
        let totalCurrent = stocksCurrent + piesCurrent;
        let totalPercent = totalPaid > 0 ? ((totalCurrent - totalPaid) / totalPaid * 100) : 0;

        // Row: label | paid CZK | current CZK | overall %
        let row = new St.BoxLayout({ style: 'padding: 5px 10px;', x_expand: true });

        let lbl = new St.Label({
            text: 'Total',
            style: 'font-weight: bold;',
            x_expand: true
        });
        row.add(lbl, { expand: true, x_fill: true });

        let paidLbl = new St.Label({
            text: 'Paid: ' + this._formatPrice(totalPaid) + ' CZK',
            style: 'text-align: right; color: #aaaaaa; min-width: 140px;'
        });
        row.add_actor(paidLbl);

        let currentLbl = new St.Label({
            text: 'Now: ' + this._formatPrice(totalCurrent) + ' CZK',
            style: 'text-align: right; min-width: 140px;'
        });
        row.add_actor(currentLbl);

        let color = totalPercent >= 0 ? '#4CAF50' : '#F44336';
        let sign = totalPercent >= 0 ? '+' : '';
        let percentLbl = new St.Label({
            text: sign + totalPercent.toFixed(2) + '%',
            style: 'text-align: right; min-width: 70px; color: ' + color + ';'
        });
        row.add_actor(percentLbl);

        this.summaryBin.add_actor(row);
    },

    _togglePause: function() {
        this._paused = !this._paused;
        if (this._paused) {
            this._pauseButton.set_label('▶ Resume');
            if (this._timeoutId) {
                Mainloop.source_remove(this._timeoutId);
                this._timeoutId = null;
            }
            this._requestQueue = [];
            this._updateStatus("Paused");
        } else {
            this._pauseButton.set_label('⏸ Pause');
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
    },

    on_applet_clicked: function() {
        this.menu.toggle();
    },

    on_applet_removed_from_panel: function() {
        if (this._timeoutId) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new Trading212Applet(metadata, orientation, panel_height, instance_id);
}
