import sys
import ssl
import base64

sys.path.append("/home/arthurf/netapp/netapp")
from NaServer import *



ssl._create_default_https_context = ssl._create_unverified_context

s = NaServer("npmng.transchip.com", 1, 100)
s.set_server_type("FILER")
s.set_transport_type("HTTPS")
s.set_port(443)
s.set_style("LOGIN")
s.set_admin_user(base64.b64decode("YWRtaW4="),base64.b64decode("MmJIcWNjQFNJUkM="))
print(s)


def quota(username):
    resultLength = -1
    outputType = 'raw'

    api = NaElement("quota-report-iter")
    api.child_add_string('max-records', '20000')

    print(api)
    xo = s.invoke_elem(api)
    print(xo)
    print(xo.sprintf())
    if (xo.results_status() == "failed"):
        print ("Error:\n")
        print (xo.sprintf())
        sys.exit(1)

    print("Collecting quota information, please wait...")

    for each in xo.sprintf().split('\n'):

        if '<disk-limit>' in each:
            diskLimitList = re.findall(r'\>(.*?)\<', each)
            diskLimitKB = ''.join(diskLimitList)

        elif '<disk-used>' in each:
            diskUsedList = re.findall(r'\>(.*?)\<', each)
            diskUsed = ''.join(diskUsedList)

        elif '<file-limit>' in each:
            fileLimit = re.findall(r'\>(.*?)\<', each)

        elif '<files-used>' in each:
            filesUsed = re.findall(r'\>(.*?)\<', each)

        elif '<quota-target>' in each:
            quotaTarget = re.findall(r'\>(.*?)\<', each)

        elif '<quota-type>' in each:
            quotaType = re.findall(r'\>(.*?)\<', each)

        elif '<quota-user-id>' in each:
            quotaUserId = re.findall(r'\>(.*?)\<', each)

        elif '<quota-user-name>' in each:
            quotaUserName = re.findall(r'\>(.*?)\<', each)

        elif '<quota-user-type>' in each:
            quotaUserType = re.findall(r'\>(.*?)\<', each)

        elif '<soft-disk-limit>' in each:
            quotaDiskLimit = re.findall(r'\>(.*?)\<', each)

        elif '<threshold>' in each:
            threshold = re.findall(r'\>(.*?)\<', each)

        elif '<tree>' in each:
            treeList = re.findall(r'\>(.*?)\<', each)
            tree = ''.join(treeList)

        elif '<volume>' in each:
            volumeList = re.findall(r'\>(.*?)\<', each)
            volume = ''.join(volumeList)

        elif '<vserver>' in each:
            vserver = re.findall(r'\>(.*?)\<', each)

        elif '</quota>' in each:

            try:
                quotaUserName
            except NameError:
                quotaUserName = ''

            if (username in quotaTarget or username in volume or username in quotaUserName):
                # Calculate quota usage in %
                try:
                    diskUtilization = 100 * (float(diskUsed) / float(diskLimitKB))
                    # Convert to GB
                    diskLimit = float(int(diskLimitKB)/1024/1024)
                    # Calculate FREE disk space (GB)
                    diskFree = (float(diskLimitKB) - float(diskUsed))/1024/1024


                except ValueError:
                    pass

                try:
                    outputType
                except:
                    showQuota()
                else:
                    if outputType == 'raw':
                        showRawData()
                    elif outputType == 'web': # Show in web format
                        showWebQuota()
                    elif (outputType != 'raw') or (outputType != 'web'):
                        showQuota()




def showQuota():
    # Cerate & populate dictionary
    thisList = {}
    if round(diskUtilization, 1) >= int(resultLength):
        thisList['Ut.%'] = round(diskUtilization, 1)
        # If not ampty add into the Dict.
        if volume != '':
            thisList['Volume'] = str(volume)
        else:
            thisList['-'] = ''
        if tree != '':
            thisList['Project'] = str(tree)
        else:
            thisList['-'] = ''
        if diskLimit != '':
            thisList['Limit'] = str(diskLimit)
        else:
            diskLimit['-'] = ''
        if diskUsed != '':
            thisList['Used'] = str(diskUsed)
        else:
            diskLimit['-'] = ''
        print(thisList)

def showRawData():
    # Cerate & populate dictionary
    thisList = {}
    if round(diskUtilization, 1) >= int(resultLength):
        thisList['Ut.%'] = round(diskUtilization, 1)
        # If not ampty add into the Dict.
        if volume != '':
            thisList['Volume'] = str(volume)
        else:
            thisList['-'] = ''

        if tree != '':
            thisList['Project'] = str(tree)
        else:
            thisList['-'] = ''

        if diskLimit != '':
            thisList['Limit'] = str(diskLimit)
        else:
            diskLimit['-'] = ''

        if diskUsed != '':
            thisList['Used'] = str(diskUsed)
        else:
            diskLimit['-'] = ''

        print(thisList)
