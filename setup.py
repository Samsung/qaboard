from setuptools import setup

setup(
    name='slamvizapp',
    packages=['slamvizapp'],
    include_package_data=True,
    install_requires=[
        'gitpython',
        'flask',
        # actually optionnal
        'flask-sqlalchemy',
    ],
)
