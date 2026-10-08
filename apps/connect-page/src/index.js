import template from './page.html';
import wordmark from '../../../docs/assets/ankka-wordmark.svg';
import { createConnectHandler } from './handler.mjs';

export default { fetch: createConnectHandler(template, wordmark) };
