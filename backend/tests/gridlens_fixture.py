"""Synthetic native PowerFactory objects for the GridLens bridge tests."""

import gridlens_runtime as gl

class PFObject:
    def __init__(self, name, kind, **attributes):
        self.loc_name = name
        self.kind = kind
        self.desc = attributes.pop("desc", "")
        self.__dict__.update(attributes)

    def GetClassName(self):
        return self.kind

    def GetFullName(self):
        return "Project\\{}\\{}.{}".format(self.kind, self.loc_name, self.kind)

    def GetContents(self, *_args):
        return []

OUTAGE_START = 1388530800

OUTAGE_END = 1388617199

PERIOD_START = 1388530800

PERIOD_END = 1388876400

class PlannedOutage(PFObject):
    """IntPlannedout as PowerFactory 2026 exposes it: data, no Apply method."""

    def __init__(self, name, *, disabled=False, equipment=None,
                 starttime=OUTAGE_START, endtime=OUTAGE_END):
        super().__init__(name, "IntPlannedout", outserv=1 if disabled else 0)
        self.starttime = starttime
        self.endtime = endtime
        self.priority = 1
        self.components = list(equipment or ())

class ElmRes(PFObject):
    def __init__(self, name="Configured QDS Result"):
        super().__init__(name, "ElmRes")
        self.deleted = False
        self.time = PFObject("Time", "SetTime")
        self.line = PFObject("Line A", "ElmLne", outserv=0, uknom=110)
        self.term = PFObject("Bus A", "ElmTerm", outserv=0, uknom=110)
        self.variables = ("b:tnow", "c:loading", "m:u", "m:phiu")
        self.objects = (self.time, self.line, self.term, self.term)
        self.units = ("h", "%", "p.u.", "deg")
        self.columns = ([0.0, 1.0], [90.0, 110.0], [0.96, 0.94], [0.0, 2.0])

    def clone(self):
        return ElmRes(self.loc_name)

    def Load(self):
        return None

    def Release(self):
        return None

    def Delete(self):
        self.deleted = True
        return None

    def GetNumberOfRows(self):
        return 2

    def GetNumberOfColumns(self):
        return len(self.columns)

    def GetVariable(self, column):
        return self.variables[column]

    def GetObject(self, column):
        return self.objects[column]

    def GetUnit(self, column):
        return self.units[column]

    def GetColumnValues(self, vector, column):
        """As PowerFactory: fills the IntVec `vector` (attribute V) with the whole column and returns 0."""
        if gl.class_name(vector) != "IntVec":
            raise TypeError("PowerFactory requires an IntVec argument")
        vector.V = list(self.columns[column])
        return 0

    def FindColumn(self, variable):
        return self.variables.index(variable)

class StudyCase(PFObject):
    def __init__(self):
        super().__init__("Study", "IntCase")
        self.copies = []

    def AddCopy(self, result):
        copy = result.clone()
        self.copies.append(copy)
        return copy

    def GetContents(self, pattern="*", *_recursive):
        return [copy for copy in self.copies if pattern in ("*", "*." + copy.kind)]

class StudyTime(PFObject):
    def __init__(self):
        super().__init__("Study Time", "SetTime", cDate=20140501, cTime=0)

class QDS(PFObject):
    def __init__(self, result, study_time, failure=None):
        super().__init__(
            "Configured QDS", "ComStatsim", results=result,
            calcPeriod=2, stepSize=1, stepUnit=2,
            iopt_net=0, iopt_at=1, iopt_maint=0,
            startTime=PERIOD_START, endTime=PERIOD_END,
        )
        self.study_time = study_time
        self.failure = failure
        self.execute_calls = 0
        self.start_times = []
        self.outage_options = []
        self.outages = []
        self.active_outages = []

    def Execute(self):
        self.execute_calls += 1
        self.active_outages.append(
            [item.loc_name for item in self.outages if item.outserv == 0])
        self.start_times.append((self.study_time.cDate, self.study_time.cTime))
        self.outage_options.append(self.iopt_maint)
        self.study_time.cDate = 20140531
        self.study_time.cTime = 23000000
        if self.failure:
            raise self.failure
        return 0

class Report(PFObject):
    def __init__(self):
        super().__init__("GridLens", "IntReport")
        self.reset_calls = 0
        self.tables = {}

    def Reset(self):
        self.reset_calls += 1
        self.tables = {}

    def CreateTable(self, name):
        self.tables[name] = {"fields": {}, "values": {}}

    def CreateField(self, table, field, field_type):
        self.tables[table]["fields"][field] = field_type

    def SetValue(self, table, field, row, value):
        self.tables[table]["values"][row, field] = value

class Script(PFObject):
    def __init__(self, parent):
        super().__init__("Run GridLens", "ComPython")
        self.parent = parent
        self.created = []

    def CreateObject(self, kind, name):
        vector = PFObject(name, kind)
        vector.deleted = False
        vector.Delete = lambda: setattr(vector, "deleted", True)
        self.created.append(vector)
        return vector

    def GetParent(self):
        return self.parent

class App:
    def __init__(self, outages=(), qds_failure=None):
        self.study = StudyCase()
        self.report = Report()
        self.script = Script(self.report)
        self.original_result = ElmRes()
        self.study_time = StudyTime()
        self.qds = QDS(self.original_result, self.study_time, qds_failure)
        self.project = PFObject("Model", "IntPrj")
        self.outage_folder = PFObject("Outages", "IntPrjfolder")
        self.outages = list(outages)
        self.qds.outages = self.outages
        self.messages = []
        self.outage_folder.GetContents = self._outage_contents
        self.project.GetContents = self._outage_contents

    def _outage_contents(self, pattern, *_args):
        return [item for item in self.outages if pattern.endswith(item.kind)]

    def PrintPlain(self, message):
        self.messages.append(message)

    def GetCurrentScript(self):
        return self.script

    def GetActiveStudyCase(self):
        return self.study

    def GetActiveProject(self):
        return self.project

    def GetProjectFolder(self, key):
        return self.outage_folder if key == "outage" else None

    def GetFromStudyCase(self, name):
        if name == "ComStatsim":
            return self.qds
        if name == "SetTime":
            return self.study_time
        return None

    def GetCalcRelevantObjects(self, _pattern, *_args):
        return []
