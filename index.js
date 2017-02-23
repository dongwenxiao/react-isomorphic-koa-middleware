import React from 'react'
import { renderToString } from 'react-dom/server'
import { createMemoryHistory, RouterContext, match } from 'react-router'
import { Provider } from 'react-redux'
import { syncHistoryWithStore } from 'react-router-redux'
import { CHANGE_LANGUAGE } from 'sp-base/client'


// 客户端开发环境webpack-dev-server端口号
const argv = require('yargs').argv
const CLIENT_DEV_DEFAULT_PORT = 3001
const CLIENT_DEV_PORT = argv.cport ? argv.cport : CLIENT_DEV_DEFAULT_PORT

// html扩展用的临时变量
let htmlExtends = resetHtmlExtends()
function resetHtmlExtends() {
    return {
        meta: []
    }
}


//

const asyncMatch = (location) => new Promise((resolve, reject) => {
    match(location, (error, redirectLocation, renderProps) => {
        if (error) {
            return reject(error)
        }

        resolve({ redirectLocation, renderProps })
    })
})


const asyncStore = async (store, renderProps) => {

    let preprocessTasks = []
    for (let component of renderProps.components) {

        // component.WrappedComponent 是redux装饰的外壳
        if (component && component.WrappedComponent && component.WrappedComponent.preprocess) {

            // 预处理异步数据的
            const preTasks = component.WrappedComponent.preprocess(store.getState(), store.dispatch)
            if (Array.isArray(preTasks)) {
                preprocessTasks = preprocessTasks.concat(preTasks)
            } else if (preTasks.then) {
                preprocessTasks.push(preTasks)
            }
        }
    }

    await Promise.all(preprocessTasks)

}

const extendHtml = (store, renderProps) => {
    for (let component of renderProps.components) {
        if (component && component.WrappedComponent && component.WrappedComponent.htmlExtends) {
            htmlExtends = resetHtmlExtends()
            component.WrappedComponent.htmlExtends(htmlExtends, store)
        }
    }
}

/**
 * 合成返回给浏览器的完整html代码
 *
 * @param {any} react渲染的html
 * @param {any} state 处理后的redux默认状态
 * @param {any} template html模板
 * @param {string} [distPathName='dist'] 引用js中间目录名，多项目可配置不同目录
 * @returns 最终返回浏览器的html
 */
function renderHtml(html, state, template, distPathName = 'dist') {

    // 样式处理
    let htmlObj = filterStyle(html)
    html = htmlObj.html
    let styles = htmlObj.styles

    // header 的 meta 生成
    let metas = htmlExtends.meta.map((meta) => {
        let metaStr = '<meta'
        for (var key in meta) {
            metaStr += ` ${key}="${meta[key]}"`
        }
        metaStr += '>'
        return metaStr
    }).join('')


    function filterStyle(htmlString) {
        let styleCollectionString = htmlString.replace(/\r\n/gi, '').replace(/\n/gi, '').match(/<div id="styleCollection(.*?)>(.*?)<\/div>/gi)[0]

        // 去掉 <div id="styleCollection">...</div>
        let onlyStyle = styleCollectionString.substr(styleCollectionString.indexOf('>') + 1, styleCollectionString.length)
        onlyStyle = onlyStyle.substr(0, onlyStyle.length - 6)

        return {
            html: htmlString.replace(/\n/gi, '').replace(styleCollectionString, ''),
            styles: onlyStyle
        }
    }

    if (template === undefined) {
        template = `
            <!DOCTYPE html>
            <html lang="en">

            <head>
                <meta charset="UTF-8">
                <script>//inject_meta</script>
                <title>React Template</title>
                <script>//inject_component_styles</script>
            </head>

            <body>
                <div id="root">
                    <div><script>//inject_html</script></div>
                </div>

                <script>//inject_redux_state</script>
                <script>//inject_js</script>

            </body>

            </html>
        `
    }

    // 序列化的redux状态
    const reduxState = `<script>window.__REDUX_STATE__ = ${JSON.stringify(state)};</script>`

    // 跟进环境，注入的js链接
    const jsLink = ((isDev) => {
        if (isDev) return `<script src="http://localhost:${CLIENT_DEV_PORT}/${distPathName}/client.js"></script>`
        else return '<script src="/client/client.js"></script>'
    })(__DEV__)

    // 返回给浏览器的html
    const responseHtml = template
        .replace('<script>//inject_component_styles</script>', styles)
        .replace('<script>//inject_meta</script>', metas)
        .replace('<script>//inject_html</script>', html)
        .replace('<script>//inject_redux_state</script>', reduxState)
        .replace('<script>//inject_js</script>', jsLink)

    return responseHtml
}


export default function (routes, configStore, template, distPathName) {

    return async (ctx, next) => {

        try {
            const memoryHistory = createMemoryHistory(ctx.url)
            const store = configStore(memoryHistory)
            const history = syncHistoryWithStore(memoryHistory, store)
            const { redirectLocation, renderProps } = await asyncMatch({ history, routes, location: ctx.url })

            if (redirectLocation) {
                ctx.redirect(redirectLocation.pathname + redirectLocation.search)
            } else if (renderProps) {

                // 准备语言到store中

                // 先查看URL参数是否有语音设置
                // hl 这个参数名是参考了Instargram
                let lang = ctx.query.hl

                // 如果没有，再看header里是否有语言设置
                if (!lang) {
                    lang = ctx.header['accept-language']
                }

                // 如没有，再用默认
                if (!lang) {
                    lang = 'en'
                }

                store.dispatch({ type: CHANGE_LANGUAGE, data: lang })

                // 告诉CDN缓存用的lang
                ctx.set('Content-Language', lang)
                ctx.set('Vary', 'Accept-Language, Accept-Encoding')

                // 准备预处理数据到store中
                await asyncStore(store, renderProps)

                // 从react里处理并扩展到html
                extendHtml(store, renderProps)

                ctx.body = renderHtml(
                    renderToString(
                        <Provider store={store}>
                            <RouterContext {...renderProps } />
                        </Provider >
                    ),
                    store.getState(),
                    template,
                    distPathName
                )
            } else {
                await next()
            }

        } catch (e) {
            console.error('Server-Render Error Occures: %s', e.stack)
            ctx.status = 500
            ctx.body = e.message
        }
    }
}