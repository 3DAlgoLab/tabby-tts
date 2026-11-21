const path = require('path')

// Tabby loads plugins as CommonJS modules inside its Electron renderer, where
// Angular, RxJS and the tabby-* packages are already loaded. Bundling them twice
// would give the plugin its own Angular instance (broken DI, broken change
// detection), so everything the host provides stays external.
const externals = [
    'electron',
    /^rxjs(\/.*)?$/,
    /^@angular\/.*$/,
    /^@ng-bootstrap\/.*$/,
    /^@ng-select\/.*$/,
    /^@ngx-translate\/.*$/,
    /^tabby-.*$/,
]

module.exports = (env, argv) => {
    const production = argv?.mode === 'production'
    return {
        target: 'node',
        entry: './src/index.ts',
        context: __dirname,
        mode: production ? 'production' : 'development',
        // 'source-map' (not eval-*) so Tabby's stack traces map back to src/*.ts
        devtool: production ? 'source-map' : 'cheap-module-source-map',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'index.js',
            libraryTarget: 'umd',
            pathinfo: false,
            devtoolModuleFilenameTemplate: 'webpack-tabby-tts:///[resource-path]',
        },
        resolve: {
            modules: [path.join(__dirname, 'src'), path.join(__dirname, 'node_modules')],
            extensions: ['.ts', '.js', '.json'],
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    loader: 'ts-loader',
                    options: { configFile: path.resolve(__dirname, 'tsconfig.json') },
                },
            ],
        },
        externals,
        // Node builtins (fs/child_process/os/path) are external under target: node.
        // The renderer keeps Node integration on; builtin plugins require('electron')
        // themselves, so no bundling of node code.
        node: { __dirname: false, __filename: false },
        stats: { modules: false, children: false },
        performance: { hints: false },
    }
}
