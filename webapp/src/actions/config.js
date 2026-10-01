import { get } from "axios";
import { setPathMappings, setDefaultGitHostname } from "../utils";

export const FETCH_SITE_CONFIG = 'FETCH_SITE_CONFIG';
export const RECEIVE_SITE_CONFIG = 'RECEIVE_SITE_CONFIG';

const defaultConfig = {
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
  git_web_url: 'https://gitlab.com',
  quota_url_template: null,
  support_url: 'https://github.com/Samsung/qaboard/issues',
};

export const fetchSiteConfig = () => {
  return dispatch => {
    dispatch({ type: FETCH_SITE_CONFIG });
    return get('/api/v1/config')
      .then(response => {
        setPathMappings(response.data.path_mappings);
        setDefaultGitHostname(response.data.git_web_url);
        dispatch({ type: RECEIVE_SITE_CONFIG, config: response.data });
        return response.data;
      })
      .catch(error => {
        console.warn('Failed to fetch site config, using defaults', error);
        dispatch({ type: RECEIVE_SITE_CONFIG, config: defaultConfig });
        return defaultConfig;
      });
  }
};
