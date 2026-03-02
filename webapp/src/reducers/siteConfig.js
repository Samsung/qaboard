import { FETCH_SITE_CONFIG, RECEIVE_SITE_CONFIG } from '../actions/config';

const initialState = {
  is_loaded: false,
  is_loading: false,
  image_servers: { default: '/iiif' },
  login_type: 'LOCAL',
  login_required: false,
  sentry_dsn: null,
  posthog_api_key: null,
  posthog_host: null,
  path_mappings: [],
  docs_root: 'https://samsung.github.io/qaboard/',
  avatar_url_template: null,
  sentry_traces_sample_rate: 1.0,
};

export function siteConfig(state = initialState, action) {
  switch (action.type) {
    case FETCH_SITE_CONFIG:
      return {
        ...state,
        is_loading: true,
      };
    case RECEIVE_SITE_CONFIG:
      return {
        ...state,
        ...action.config,
        is_loaded: true,
        is_loading: false,
      };
    default:
      return state;
  }
}
