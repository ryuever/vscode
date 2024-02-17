/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const withDefaults = require('../shared.webpack.config');
console.log('jake -----------------')

module.exports = withDefaults({
	context: __dirname,
	entry: {
		main: './src/main.ts',
	},
	resolve: {
		mainFields: ['module', 'main']
	}
});
