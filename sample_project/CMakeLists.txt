cmake_minimum_required (VERSION 2.6)
project (sample_project)

find_package ( Boost 1.61 COMPONENTS program_options REQUIRED )

include_directories (SYSTEM ${Boost_INCLUDE_DIR} )
include_directories ("${PROJECT_SOURCE_DIR}/src/include")

add_executable(${PROJECT_NAME} src/slam.cxx)


set_target_properties(${PROJECT_NAME} PROPERTIES
  CXX_STANDARD 17
  CXX_EXTENSIONS OFF
)

target_link_libraries( ${PROJECT_NAME} ${Boost_LIBRARIES} )




# in a real project you would
# - maybe create a shared lib, link your tests/CLI binary against it
# - change compiler flags via env variables or cmake parameters
# - define a target command that computes coverage
# - ...
#
# talk to @arthurf for help

