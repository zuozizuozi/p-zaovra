# 前端操作审查：2026-09-10

本轮按用户要求检查并汇报，未修改产品代码。检查对象是用户正在运行的开发桌面（CDP9222，localhost:5173），不是此前的隔离测试包。范围为桌面窗口外壳、首页、菜单、设置及嵌套下拉框；不声称所有功能页面已全部遍历。没有修改模型配置、发送任务或操作项目文件。

结论：基础桌面交互仍存在明确缺陷。此前任务执行链路的测试不能证明窗口外壳和设置导航已满足正常使用习惯。

## 必须修复的操作问题

### I1 / P1：设置没有可见退出入口

实际设置弹窗中关闭按钮数量为0，没有返回或完成按钮。点击外部被Dialog组件onInteractOutside.preventDefault阻止，用户只能依赖未提示的Esc。已用Esc成功返回工作台；不是程序死锁，但鼠标操作用户没有明确出路。

位置：packages/app-ui/src/components/settings-v2/dialog-settings-v2.tsx:29；packages/ui/src/v2/components/dialog-v2.tsx:94。

要求：固定、可见且有标签的关闭设置入口；Esc作为补充，不作为唯一出口。不能用标题栏关闭整应用的X代替关闭设置。

### I2 / P1：设置弹窗使窗口拖动区域失效

实测弹窗开启时#root aria-hidden=true，侧栏顶部和HEADER两个拖动区域的app-region均为none；关闭设置后aria-hidden解除，两个区域均恢复drag。CSS把可拖动区域绑定在#root:not([aria-hidden])上。弹窗覆盖整个窗口且没有自己的拖动区域。

位置：packages/ui/src/styles/base.css:85；packages/ui/src/v2/components/dialog-v2.css:3；packages/app-ui/src/components/desktop-sidebar.tsx:128。

要求：打开设置等模态界面时仍保留合适的窗口移动区域，同时保证按钮不参与拖动。本轮证据是实际渲染样式与用户拖动失败反馈；没有据此声称无弹窗下所有原生拖动行为都已验证。

### I3 / P2：新版桌面没有可见的后退/前进入口

工作台实际按钮中未找到后退/前进。Titlebar保留历史逻辑和Ctrl+[、Ctrl+]命令，但可见导航按钮在旧布局分支；新桌面又启用minimal标题栏。品牌Zaovra按钮承担主页切换，但没有明确主页提示。

位置：packages/app-ui/src/components/titlebar.tsx:163、:471、:648；packages/app-ui/src/pages/layout-new.tsx；packages/app-ui/src/components/desktop-sidebar.tsx:140。

要求：提供稳定可见的返回/前进和主页入口；Windows习惯的Alt+Left/Right可作为补充；无历史时正确禁用。页面返回与关闭设置是两类不同动作，都需要可见出口。

### I4 / P2：Esc关闭层级错误

复现：打开设置→展开简体中文下拉框→不选择任何语言→按一次Esc。实际整个设置消失，而不只是下拉框关闭。全局DialogProvider在capture阶段直接close当前dialog，抢在内部浮层处理前关闭父层。

位置：packages/ui/src/context/dialog.tsx:69–75。

要求：Esc首先关闭最上层下拉菜单/弹出层，再次按Esc才退出设置；输入表单需要各自的退出策略。此次没有修改任何设置值，也未将“表单丢失”当作已经复现的事实。

### I5 / P2：新版菜单保留无法执行的旧布局命令

实测View→Toggle Sidebar为disabled；Go→Previous/Next Session、Previous/Next Project均为disabled。相关命令只在旧layout.tsx注册；新版固定侧栏没有对应注册或收起逻辑。这些入口与新布局未同步迁移，不能简单解释成全部正常的状态禁用。

位置：packages/app-ui/src/pages/layout.tsx:900、:914、:947；packages/app-ui/src/desktop-menu.ts；packages/app-ui/src/components/desktop-sidebar.tsx。

证据：interaction-go-menu.txt。首页Toggle File Tree禁用可能是合理上下文状态，本轮不单独当作缺陷。

要求：逐项连接新版实现；确实不支持的功能不长期展示无法使用的入口，并给出必要状态原因。侧栏应有收起/展开方式，避免小窗口始终占据固定宽度。

## 设计及可访问性不足

### I6 / P2：长设置面板完全隐藏滚动条

实测可视高度600px、内容高度2428px、scrollbar-width=none；截图中下方选项截断，但没有明确滚动位置提示。并非不能滚动，而是内容和当前位置难发现，也无法直接拖动滚动条。

位置：packages/app-ui/src/components/settings-v2/settings-v2.css:22。

要求：保留细滚动条或悬停显示的可操作滚动条；固定标题与关闭入口，滚到底仍能退出。

### I7 / P3：中文界面与英文应用菜单混杂

实测中文工作台中菜单仍显示File、View、Go、Toggle Sidebar等；菜单定义使用硬编码英文label。专业术语可以保留，但基础操作名称应跟随用户语言。

位置：packages/app-ui/src/desktop-menu.ts；packages/app-ui/src/components/windows-app-menu.tsx:90。

### I8 / P3：设置弹窗没有可访问名称

实际role=dialog的aria-label和aria-labelledby均为空；内容中的“通用”标题没有通过DialogTitle与对话框关联。键盘或读屏用户缺少明确的弹窗身份及退出提示。

位置：packages/app-ui/src/components/settings-v2/dialog-settings-v2.tsx:29。

### I9 / P3：首页重复操作与调试控件干扰测试体验

同屏有多处新建会话、设置和帮助入口；品牌按钮负责主页切换但缺少明确提示。开发版默认露出NAV/FPS等调试条与Force focus styles控件，容易让业务测试用户误触或误解。调试功能本身不是缺陷，但应通过明确开发开关控制可见性。

位置：packages/app-ui/src/components/desktop-sidebar.tsx；packages/app-ui/src/pages/home.tsx；packages/app-ui/src/components/debug-bar.tsx:115；packages/app-ui/src/pages/layout-new.tsx。

## 建议修复顺序及验收

1. 先修设置的可见关闭入口、模态状态拖动、Esc层级。实际鼠标拖动普通窗口与设置状态；在下拉框、子弹窗和设置主面板逐层验证Esc。
2. 补新版返回/主页入口，清理旧菜单命令，验证首页→会话→设置→返回的完整操作；无项目、已有项目、多会话三种状态分别检查菜单。
3. 修滚动提示、菜单语言、可访问名称及调试入口；用普通窗口、小窗口和高缩放检查控件是否可达。

本轮已用Esc退出设置并收起审查过程中打开的菜单，用户工作台保持可操作。未重启应用或服务，未打包。原生窗口拖动、缩放和所有业务表单的完整交互验收仍应在修复后逐项实测，不能再由类型检查或业务单元测试替代。
