# 网页搜索与读取

打开小毛球主聊的「插件与 Skill」，在「网页搜索与读取」中审查并启用。只使用网页读取时，可保留空白搜索服务。

| 服务 | 配置 |
| --- | --- |
| Brave Search | 选择 `brave`，在启动工作台的进程环境设置 `MAOQIU_PLUGIN_KEY_BRAVE`，或填写另一个 `MAOQIU_PLUGIN_KEY_*` 变量名。使用 Brave 提供的 API 凭据和额度。 [Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) |
| SearXNG | 选择 `searxng`，填写站点的完整 `/search` 端点，并在该实例允许 JSON 格式。自建服务使用局域网地址时打开指定局域网选项。 [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) |

在插件中分别测试搜索词或网页 URL。对话里可以说「搜索公开资料里对 RFC 9110 的介绍，打开主要来源，给出链接」或直接提供 URL。关键词须来自当前消息。公开读取会验证解析得到的全部地址、锁定连接地址、逐跳重验重定向，并检查 robots.txt。支持静态 HTML、纯文本和 JSON。需要登录、运行 JavaScript 或解析 PDF 的页面可能无法提取。

工具卡中的「网页来源」展示实际响应。可在同一个请求中要求「读取这个 URL 并归档到当前项目」。批准归档卡后，资料库保存网页正文、URL、抓取时间、记录和项目访问范围。停用插件会移除搜索、读取和随附 Skill，归档资料仍可查看。
