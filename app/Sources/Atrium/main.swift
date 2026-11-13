// Atrium for macOS: a small native window around the Atrium page.
//
// What the app adds over a browser tab:
//   - notifications when a run finishes or needs your confirmation
//   - a dock badge with the number of runs waiting for you
//   - sign-in without the terminal: it runs your sign-in command and opens the link
//   - its own window, remembered size, standard shortcuts
import AppKit
import UserNotifications
import WebKit

let defaults = UserDefaults.standard
let kServerURL = "serverURL"
let kSignInCommand = "signInCommand"
let defaultServerURL = "http://127.0.0.1:13005"

/// Menus and dialogs follow the system language: Chinese if it comes first, English otherwise.
let useChinese = (Locale.preferredLanguages.first ?? "").hasPrefix("zh")
func L(_ zh: String, _ en: String) -> String { useChinese ? zh : en }

func serverURL() -> URL {
    let s = (defaults.string(forKey: kServerURL) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return URL(string: s.isEmpty ? defaultServerURL : s) ?? URL(string: defaultServerURL)!
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
    UNUserNotificationCenterDelegate, NSWindowDelegate
{
    var window: NSWindow!
    var webView: WKWebView!
    var settingsWindow: NSWindow?
    var urlField: NSTextField!
    var commandField: NSTextField!
    var signingIn = false
    var autoSignInTried = false

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "atrium")
        config.websiteDataStore = .default() // cookies persist between launches
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground") // no white flash in dark mode

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Atrium"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 420, height: 480)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("AtriumMain")
        window.makeKeyAndOrderFront(nil)
        layoutWindowButtons()

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }

        load()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    @objc func load() {
        webView.load(URLRequest(url: serverURL()))
    }

    // MARK: window chrome

    /// The page draws its own 52pt header across the top of the window. The
    /// close / minimise / zoom buttons are moved down to sit centred in it.
    let headerHeight: CGFloat = 52

    func layoutWindowButtons() {
        guard !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let container = close.superview?.superview else { return }
        var f = container.frame
        f.size.height = headerHeight
        f.origin.y = window.frame.height - headerHeight
        container.frame = f
        let y = (headerHeight - close.frame.height) / 2
        for (i, button) in [close, mini, zoom].enumerated() {
            button.setFrameOrigin(NSPoint(x: 18 + CGFloat(i) * 20, y: y))
        }
    }

    func windowDidResize(_ notification: Notification) { layoutWindowButtons() }
    func windowDidBecomeKey(_ notification: Notification) { layoutWindowButtons() }
    func windowDidEnterFullScreen(_ notification: Notification) { tellPage(fullScreen: true) }
    func windowDidExitFullScreen(_ notification: Notification) {
        tellPage(fullScreen: false)
        layoutWindowButtons()
    }

    /// In full screen there are no window buttons to leave room for.
    func tellPage(fullScreen: Bool) {
        webView.evaluateJavaScript("document.documentElement.classList.toggle('fullscreen', \(fullScreen))", completionHandler: nil)
    }

    /// Menu commands the page carries out itself (it listens for the same event from its own shortcuts).
    @objc func pageCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('atrium:cmd', {detail: '\(name)'}))", completionHandler: nil)
    }

    @objc func reload() {
        if webView.url == nil || webView.url?.scheme == "about" { load() } else { webView.reload() }
    }

    // MARK: menu

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L("关于 Atrium", "About Atrium"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L("设置…", "Settings…"), action: #selector(showSettings), keyEquivalent: ",")
        appMenu.addItem(withTitle: L("登录", "Sign In"), action: #selector(signInFromMenu), keyEquivalent: "l")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L("隐藏 Atrium", "Hide Atrium"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: L("退出 Atrium", "Quit Atrium"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        func command(_ title: String, _ name: String, _ key: String, shift: Bool = false) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: #selector(pageCommand(_:)), keyEquivalent: key)
            item.representedObject = name
            if shift { item.keyEquivalentModifierMask = [.command, .shift] }
            return item
        }

        let fileItem = NSMenuItem()
        let file = NSMenu(title: L("文件", "File"))
        file.addItem(command(L("新会话", "New Session"), "new", "n"))
        file.addItem(command(L("搜索…", "Search…"), "search", "k"))
        file.addItem(.separator())
        file.addItem(command(L("从这里分叉", "Fork from Here"), "fork", "f", shift: true))
        fileItem.submenu = file
        main.addItem(fileItem)

        // Without an Edit menu, ⌘C / ⌘V / ⌘A do not reach the page.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: L("编辑", "Edit"))
        edit.addItem(withTitle: L("撤销", "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: L("重做", "Redo"), action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: L("剪切", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L("拷贝", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L("粘贴", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L("全选", "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: L("显示", "View"))
        view.addItem(command(L("显示 / 收起侧栏", "Toggle Sidebar"), "sidebar", "b"))
        view.addItem(command(L("边聊", "Side Chat"), "side", "."))
        view.addItem(command(L("终端", "Terminal"), "terminal", "j"))
        view.addItem(command(L("文件", "Files"), "files", "e"))
        view.addItem(.separator())
        view.addItem(withTitle: L("重新载入", "Reload"), action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: L("回到首页", "Home"), action: #selector(load), keyEquivalent: "0")
        view.addItem(.separator())
        view.addItem(withTitle: L("放大", "Zoom In"), action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: L("缩小", "Zoom Out"), action: #selector(zoomOut), keyEquivalent: "-")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: L("窗口", "Window"))
        win.addItem(withTitle: L("最小化", "Minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: L("关闭窗口", "Close Window"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = win
        main.addItem(windowItem)
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    @objc func zoomIn() { webView.pageZoom = min(2.0, webView.pageZoom + 0.1) }
    @objc func zoomOut() { webView.pageZoom = max(0.6, webView.pageZoom - 0.1) }

    // MARK: settings

    @objc func showSettings() {
        if settingsWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 250),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = L("Atrium 设置", "Atrium Settings")
            w.isReleasedWhenClosed = false
            let v = NSView(frame: w.contentView!.bounds)

            func label(_ text: String, _ y: CGFloat, small: Bool = false) -> NSTextField {
                let l = NSTextField(wrappingLabelWithString: text)
                l.frame = NSRect(x: 24, y: y, width: 512, height: small ? 30 : 18)
                l.font = .systemFont(ofSize: small ? 11 : 13, weight: small ? .regular : .medium)
                l.textColor = small ? .secondaryLabelColor : .labelColor
                return l
            }
            v.addSubview(label(L("服务器地址", "Server address"), 208))
            urlField = NSTextField(frame: NSRect(x: 24, y: 180, width: 512, height: 24))
            urlField.placeholderString = defaultServerURL
            v.addSubview(urlField)
            v.addSubview(label(L("通过隧道访问时是 \(defaultServerURL)；配了域名就填 https 地址。", "\(defaultServerURL) when you use the SSH tunnel; your https address if you set up a domain."), 146, small: true))

            v.addSubview(label(L("登录命令（可选）", "Sign-in command (optional)"), 120))
            commandField = NSTextField(frame: NSRect(x: 24, y: 92, width: 512, height: 24))
            commandField.placeholderString = "ssh root@my.server runuser -u atrium -- atrium login-link --base \(defaultServerURL)"
            commandField.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            v.addSubview(commandField)
            v.addSubview(label(L("这条命令需要输出一次性登录链接。填了之后，未登录时应用会自动运行它并完成登录。", "A command that prints a one-time sign-in link. When set, the app runs it whenever you are signed out."), 58, small: true))

            let save = NSButton(title: L("保存", "Save"), target: self, action: #selector(saveSettings))
            save.frame = NSRect(x: 446, y: 16, width: 90, height: 30)
            save.keyEquivalent = "\r"
            v.addSubview(save)
            w.contentView = v
            w.center()
            settingsWindow = w
        }
        urlField.stringValue = defaults.string(forKey: kServerURL) ?? ""
        commandField.stringValue = defaults.string(forKey: kSignInCommand) ?? ""
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func saveSettings() {
        defaults.set(urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: kServerURL)
        defaults.set(commandField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: kSignInCommand)
        settingsWindow?.close()
        autoSignInTried = false
        load()
    }

    // MARK: sign-in

    @objc func signInFromMenu() { signIn(userInitiated: true) }

    /// Runs the configured command, takes the one-time link it prints and opens it.
    func signIn(userInitiated: Bool) {
        let command = (defaults.string(forKey: kSignInCommand) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if command.isEmpty {
            if userInitiated { showSettings() }
            return
        }
        if signingIn { return }
        signingIn = true
        DispatchQueue.global(qos: .userInitiated).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/zsh")
            p.arguments = ["-lc", command]
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            p.standardInput = FileHandle.nullDevice
            var text = "", errText = ""
            do {
                try p.run()
                text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                errText = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                p.waitUntilExit()
            } catch {
                errText = error.localizedDescription
            }
            let link = text.split(whereSeparator: { $0 == "\n" || $0 == " " })
                .map(String.init).first(where: { $0.hasPrefix("http") && $0.contains("login=") })
            DispatchQueue.main.async {
                self.signingIn = false
                if let link = link, let code = link.components(separatedBy: "login=").last {
                    // Use the address from Settings, so the cookie lands on the page the app shows.
                    var base = serverURL().absoluteString
                    while base.hasSuffix("/") { base.removeLast() }
                    if let url = URL(string: base + "/#login=" + code) {
                        self.webView.load(URLRequest(url: url))
                        // Same-document navigation would not re-run the page's sign-in code.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.webView.reload() }
                    }
                } else if userInitiated {
                    let a = NSAlert()
                    a.messageText = L("登录命令没有输出登录链接", "The sign-in command printed no sign-in link")
                    a.informativeText = String((errText.isEmpty ? text : errText).suffix(600))
                    a.runModal()
                }
            }
        }
    }

    func checkSignedIn() {
        let js = "fetch('/api/auth').then(r => r.json()).then(j => window.webkit.messageHandlers.atrium.postMessage({type: 'auth', authed: !!j.authed})).catch(() => {})"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: page → app

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let type = m["type"] as? String else { return }
        switch type {
        case "auth":
            if (m["authed"] as? Bool) == false, !autoSignInTried {
                autoSignInTried = true
                signIn(userInitiated: false)
            }
        case "drag":
            // The page's header stands in for the title bar: dragging it moves the window.
            if let e = NSApp.currentEvent, e.type == .leftMouseDown || e.type == .leftMouseDragged {
                window.performDrag(with: e)
            }
        case "zoom":
            window.zoom(nil)
        case "badge":
            let n = m["count"] as? Int ?? 0
            NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        case "attention":
            let kind = m["kind"] as? String ?? ""
            // Finished runs only matter when you are not looking; a permission request always does.
            if kind != "permission" && NSApp.isActive { return }
            let c = UNMutableNotificationContent()
            let name = m["title"] as? String ?? ""
            switch kind {
            case "permission": c.title = L("需要你确认", "Needs your OK")
            case "done": c.title = L("已完成", "Done")
            case "stopped": c.title = L("已停止", "Stopped")
            default: c.title = L("运行出错", "Run failed")
            }
            let detail = m["detail"] as? String ?? ""
            c.body = detail.isEmpty ? name : "\(name)\n\(detail)"
            c.sound = kind == "done" || kind == "stopped" ? nil : .default
            c.userInfo = ["session": m["session"] as? String ?? ""]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        default:
            break
        }
    }

    // Clicking a notification opens that session.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let key = response.notification.request.content.userInfo["session"] as? String ?? ""
        DispatchQueue.main.async {
            self.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            if !key.isEmpty, let data = try? JSONSerialization.data(withJSONObject: [key]),
               let arr = String(data: data, encoding: .utf8) {
                self.webView.evaluateJavaScript("location.hash = '#/s/' + encodeURIComponent(\(arr)[0])", completionHandler: nil)
            }
        }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        checkSignedIn()
        tellPage(fullScreen: window.styleMask.contains(.fullScreen))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline(error)
    }

    func showOffline(_ error: Error) {
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let html = """
        <html><head><meta charset="utf-8"><style>
        body{font:15px -apple-system,'PingFang SC',sans-serif;display:grid;place-items:center;height:100vh;margin:0;
        background:\(dark ? "#1b1c1f" : "#f6f5f1");color:\(dark ? "#e9e7e2" : "#1c1d21")}
        div{max-width:460px;text-align:center;line-height:1.7} p{color:#8a919b;font-size:13px} a{color:#7c86ff} b{color:\(dark ? "#e9e7e2" : "#1c1d21")}
        button{font:inherit;padding:7px 18px;border-radius:9px;border:0;background:#4f58d8;color:#fff;margin-top:8px}
        code{font:12px ui-monospace,Menlo,monospace}
        </style></head><body><div>
        <h3>\(L("连不上 Atrium", "Cannot reach Atrium"))</h3>
        <p>\(L("地址：", "Address: "))<code>\(serverURL().absoluteString)</code><br>\(error.localizedDescription)</p>
        <p>\(L("这个应用只是一个窗口，显示的是 Atrium 的页面。<b>第一次用？</b>需要先把 Atrium 装在这台电脑上，或者把这台电脑接到你的 Atrium 服务器：", "This app is a window onto the Atrium page. <b>First time?</b> Atrium has to be installed on this Mac first, or this Mac connected to your Atrium server:")) <a href="\(L("https://github.com/wx9Songs/atrium/blob/main/README.zh-CN.md#快速开始", "https://github.com/wx9Songs/atrium#quick-start"))">\(L("安装说明", "how to install"))</a></p>
        <p>\(L("已经装过：如果是通过隧道访问，请确认这台电脑上的隧道在运行；地址可以在「设置」（⌘,）里修改。", "Already installed: if you use the SSH tunnel, check that it is running on this Mac. The address can be changed in Settings (⌘,)."))</p>
        <button onclick="location.href='\(serverURL().absoluteString)'">\(L("重试", "Retry"))</button>
        </div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // Links to other sites open in the default browser, not inside the app.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, let scheme = url.scheme, scheme.hasPrefix("http"),
           url.host != serverURL().host, navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) } // target=_blank
        return nil
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
