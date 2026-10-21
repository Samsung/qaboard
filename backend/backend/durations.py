"""Human-readable durations: 2weeks, 1month, 3days 4h..."""
import re
import datetime


delta_re = re.compile(r'^((?P<years>[\.\d]+?)y(ear)?s?)? *((?P<months>[\.\d]+?)m(onth)?s?)? *((?P<weeks>[\.\d]+?)w(eek)?s?)? *((?P<days>[\.\d]+?)d(ay)?s?)? *((?P<hours>[\.\d]+?)h(our)?s?)? *((?P<minutes>[\.\d]+?)min(ute)?s?)? *((?P<seconds>[\.\d]+?)s(econd)?s?)?$')
def parse_time(time_str):
    """
    Parse a time string e.g. (2h13m) into a timedelta object.
    Modified from virhilo's answer at https://stackoverflow.com/a/4628148/851699
    :param time_str: A string identifying a duration.  (eg. 2h13m)
    :return datetime.timedelta
    """
    parts = delta_re.match(time_str)
    assert parts is not None, f"Could not parse any time information from '{time_str}'.  Examples of valid strings: '1y', '2months 20d', '8h', '2d8h5min20s', '2min4s'"
    groupdict = parts.groupdict()
    if not groupdict.get('days'):
        groupdict['days'] = 0
    else:
        groupdict['days'] = float(groupdict['days'])
    if groupdict.get('weeks'):
        groupdict['days'] = groupdict['days'] + 7 * float(groupdict['weeks'])
        del groupdict['weeks']
    if groupdict.get('months'):
        groupdict['days'] = groupdict['days'] + 31 * float(groupdict['months'])
        del groupdict['months']
    if groupdict.get('years'):
        groupdict['days'] = groupdict['days'] + 365 * float(groupdict['years'])
        del groupdict['years']
    time_params = {name: float(param) for name, param in groupdict.items() if param}
    return datetime.timedelta(**time_params)
