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

    @objc func reload() {
        if webView.url == nil || webView.url?.scheme == "about" { load() } else { webView.reload() }
    }

    // MARK: menu

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Atrium", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "设置…", action: #selector(showSettings), keyEquivalent: ",")
        appMenu.addItem(withTitle: "登录", action: #selector(signInFromMenu), keyEquivalent: "l")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Atrium", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Atrium", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Without an Edit menu, ⌘C / ⌘V / ⌘A do not reach the page.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "显示")
        view.addItem(withTitle: "重新载入", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "回到首页", action: #selector(load), keyEquivalent: "0")
        view.addItem(.separator())
        view.addItem(withTitle: "放大", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "缩小", action: #selector(zoomOut), keyEquivalent: "-")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let win = NSMenu(title: "窗口")
        win.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
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
            w.title = "Atrium 设置"
            w.isReleasedWhenClosed = false
            let v = NSView(frame: w.contentView!.bounds)

            func label(_ text: String, _ y: CGFloat, small: Bool = false) -> NSTextField {
                let l = NSTextField(wrappingLabelWithString: text)
                l.frame = NSRect(x: 24, y: y, width: 512, height: small ? 30 : 18)
                l.font = .systemFont(ofSize: small ? 11 : 13, weight: small ? .regular : .medium)
                l.textColor = small ? .secondaryLabelColor : .labelColor
                return l
            }
            v.addSubview(label("服务器地址", 208))
            urlField = NSTextField(frame: NSRect(x: 24, y: 180, width: 512, height: 24))
            urlField.placeholderString = defaultServerURL
            v.addSubview(urlField)
            v.addSubview(label("通过隧道访问时是 \(defaultServerURL)；配了域名就填 https 地址。", 146, small: true))

            v.addSubview(label("登录命令（可选）", 120))
            commandField = NSTextField(frame: NSRect(x: 24, y: 92, width: 512, height: 24))
            commandField.placeholderString = "ssh root@my.server runuser -u atrium -- atrium login-link --base \(defaultServerURL)"
            commandField.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            v.addSubview(commandField)
            v.addSubview(label("这条命令需要输出一次性登录链接。填了之后，未登录时应用会自动运行它并完成登录。", 58, small: true))

            let save = NSButton(title: "保存", target: self, action: #selector(saveSettings))
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
                    a.messageText = "登录命令没有输出登录链接"
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
            case "permission": c.title = "需要你确认"
            case "done": c.title = "已完成"
            case "stopped": c.title = "已停止"
            default: c.title = "运行出错"
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
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline(error)
    }

    func showOffline(_ error: Error) {
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let html = """
        <html><head><meta charset="utf-8"><style>
        body{font:15px -apple-system,'PingFang SC',sans-serif;display:grid;place-items:center;height:100vh;margin:0;
        background:\(dark ? "#1e1f22" : "#f7f6f3");color:\(dark ? "#e7e6e2" : "#1f2328")}
        div{max-width:440px;text-align:center;line-height:1.7} p{color:#8a919b;font-size:13px}
        button{font:inherit;padding:7px 18px;border-radius:9px;border:0;background:#3b5bdb;color:#fff;margin-top:8px}
        code{font:12px ui-monospace,Menlo,monospace}
        </style></head><body><div>
        <h3>连不上 Atrium</h3>
        <p>地址：<code>\(serverURL().absoluteString)</code><br>\(error.localizedDescription)</p>
        <p>如果是通过隧道访问，请确认这台电脑上的隧道在运行；地址可以在「设置」（⌘,）里修改。</p>
        <button onclick="location.href='\(serverURL().absoluteString)'">重试</button>
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
